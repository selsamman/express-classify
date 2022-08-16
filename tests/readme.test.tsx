// noinspection JSConstantReassignment

import {serializable} from "js-freeze-dry";
import {ExpressServer, ServerEndPoints} from "../src";
import {ExpressClient} from "express-classify-client";
import createMemoryStore from "memorystore";
import Session from "express-session";
import {createHttpTerminator, HttpTerminator} from "http-terminator";


/**
 * @jest-environment jsdom
 */
describe("tests", () => {

    const users = new Map<string, User>();

    let resolve : any;
    let waitForServer;
    const expressServer = new ExpressServer();;

    class UserRequest {
        async registerUser(_email : string, _name : string, _password : string) {}
        async login(_email : string, _password : string) {return undefined as unknown as User}
        async logout() {}
        async greetAll() {}
    }

    class User {
        constructor(name : string, email : string, password : string) {
            this.name = name; this.email = email; this.password = password;
        }
        name;
        email;
        password;
    }
    serializable({User});

    class AlertBrowserRequest {
        sendMessage(_msg : string) {}
    }

    class AlterBrowserImplementation implements AlertBrowserRequest {
        sendMessage(msg : string) {
            resolve(msg);
        }
    }

    class ServerRequest {
        async serverDirectCB() {}
        async serverBroadcastCB() {}
    }
    class ServerEndpoint extends ServerEndPoints implements ServerRequest {

        async serverDirectCB () {
            (await this.getRequest(AlertBrowserRequest)).sendMessage("Hello");
        }

        async serverBroadcastCB() {
            expressServer.enumerateSessions( (_, getRequest) => {
                const browserRequest = getRequest(AlertBrowserRequest) as AlertBrowserRequest;
                browserRequest.sendMessage('hello out there from the server');
            });
        }

    }
    serializable({ServerEndpoint});

    class UserEndPoint extends ServerEndPoints implements UserRequest {

        user : User | undefined; // session data

        async registerUser(email : string, name : string, password : string) {
            users.set(email, new User(name, email, password));
        }

        async login(email : string, password : string) {
            const user = users.get(email);
            if (!user || user.password != password)
                throw new Error("invalid email or password");
            else {
                this.user = new User(user.name, user.email, '*****');
                return this.user;
            }
        }

        async logout () {
            if (this.user)
                this.user = undefined;
            else
                throw new Error('No one logged in');
        }

        async greetAll () {

            await expressServer.enumerateSessions( (getImplementation, getRequest) => {
                const browserRequest = getRequest(AlertBrowserRequest) as AlertBrowserRequest;
                const userEndPoint = getImplementation(UserEndPoint) as UserEndPoint
                const name = userEndPoint?.user?.name || "";
                browserRequest.sendMessage(`Hi ${name} how are you?`);
            });
        }
    }
    serializable({UserEndPoint});

    expressServer.setPort(80);
    const MemoryStore = createMemoryStore(Session);
    expressServer.setSessionStore(new MemoryStore({})); // Omit the aging to avoid .unref issue
    expressServer.setSessionOptions({
        cookie: { maxAge: 86400000 }, // 24 hours
        resave: true,
        saveUninitialized: true,
        secret: 'keyboard cat',
        genid: () => 'fixed-session-id'
    });

    expressServer.createEndPoint("users", UserEndPoint, UserRequest);
    expressServer.createEndPoint("server", ServerEndpoint, ServerRequest);
    expressServer.createRequest("client", AlertBrowserRequest);

    let terminator : HttpTerminator | undefined;

    beforeAll( () =>
    {
        expressServer.start();
        if (expressServer.server)
            terminator = createHttpTerminator({server: expressServer.server})
    })

    const expressClient = new ExpressClient();


    it("Register and Login (Read.me)", async () => {

        const userRequest = expressClient.createRequest("users", new UserRequest());
        await userRequest.registerUser("foo@bar.com", "Foo Bar", "foo123");
        await expressClient.createResponse("client", new AlterBrowserImplementation);

        // Login with bad password
        expect(userRequest.login("foo@bar.com", "")).rejects.toThrow(new Error("invalid email or password"));

        // Login with good password
        expect(await userRequest.login("foo@bar.com", "foo123")).toStrictEqual(new User("Foo Bar", "foo@bar.com", '*****'));

        // Callback with session data
        waitForServer = new Promise ( r => resolve = r);
        await userRequest.greetAll();
        expect(await waitForServer).toBe("Hi Foo Bar how are you?");

        // Logout
        await userRequest.logout();
        // Make sure it can't be done again
        expect(userRequest.logout).rejects.toThrow(new Error('No one logged in'));

    });

    it("Callback to browser (read.me)", async () => {

        await expressClient.createResponse("client", new AlterBrowserImplementation);
        const serverRequest = expressClient.createRequest("server", new ServerRequest());

        waitForServer = new Promise ( r => resolve = r);
        await serverRequest.serverDirectCB();
        expect(await waitForServer).toBe("Hello");

        waitForServer = new Promise ( r => resolve = r);
        await serverRequest.serverBroadcastCB();
        expect(await waitForServer).toBe("hello out there from the server");


    });

    afterAll(async () => {
        expressServer.io.close();
        if (terminator) {
            console.log("FOO");
            await terminator.terminate();
        }
    });

});
