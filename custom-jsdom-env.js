// custom-jsdom-environment
const JSDOMEnvironment = require('jest-environment-jsdom')
const { ResourceLoader, JSDOM, VirtualConsole } = require('jsdom')
const { installCommonGlobals } = require('jest-util')
const { ModuleMocker } = require('jest-mock')
const { LegacyFakeTimers, ModernFakeTimers } = require('@jest/fake-timers')

class CustomEnvironment extends JSDOMEnvironment {
    constructor(config, context) {
        super(config, context)

        this.dom = new JSDOM('<!DOCTYPE html>', {
            pretendToBeVisual: true,
            runScripts: 'dangerously',
            url: config.testURL,
            virtualConsole: new VirtualConsole().sendTo(context.console || console),
            ...config.testEnvironmentOptions,
            resources: new ResourceLoader({ strictSSL: false }),
        })
        const global = (this.global = this.dom.window.document.defaultView)

        if (!global) {
            throw new Error('JSDOM did not return a Window object')
        }

        // for "universal" code (code should use `globalThis`)
        global.global = global

        // Node's error-message stack size is limited at 10, but it's pretty useful
        // to see more than that when a test fails.
        this.global.Error.stackTraceLimit = 100
        installCommonGlobals(global, config.globals)

        // Report uncaught errors.
        this.errorEventListener = (event) => {
            if (userErrorListenerCount === 0 && event.error) {
                process.emit('uncaughtException', event.error)
            }
        }
        global.addEventListener('error', this.errorEventListener)

        // However, don't report them as uncaught if the user listens to 'error' event.
        // In that case, we assume the might have custom error handling logic.
        const originalAddListener = global.addEventListener
        const originalRemoveListener = global.removeEventListener
        let userErrorListenerCount = 0
        global.addEventListener = function(...args) {
            if (args[0] === 'error') {
                userErrorListenerCount++
            }
            return originalAddListener.apply(this, args)
        }
        global.removeEventListener = function(...args) {
            if (args[0] === 'error') {
                userErrorListenerCount--
            }
            return originalRemoveListener.apply(this, args)
        }

        this.moduleMocker = new ModuleMocker(global)

        const timerConfig = {
            idToRef: (id) => id,
            refToId: (ref) => ref,
        }

        this.fakeTimers = new LegacyFakeTimers({
            config,
            global,
            moduleMocker: this.moduleMocker,
            timerConfig,
        })

        this.fakeTimersModern = new ModernFakeTimers({ config, global })
    }

    async setup() {
        await super.setup()
    }

    async teardown() {
        await super.teardown()
    }

    runScript(script) {
        return super.runScript(script)
    }
}

module.exports = CustomEnvironment
