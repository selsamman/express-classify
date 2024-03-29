import {Server, Socket} from "socket.io";
import express, {Express, RequestHandler} from "express";
import Session, {SessionOptions, Store} from "express-session";
import createMemoryStore from "memorystore";
import bodyParser from "body-parser";
import {deserialize, serialize} from "js-freeze-dry";
import * as http from "http";
import * as https from "https";

declare module "express-session" {
    interface SessionData {
        socketId: string;
        endPoints : {[index : string] : string}
    }
}

export class ExpressServer {

    io: Server = undefined as unknown as Server; // SocketIO
    app: Express = undefined as unknown as Express; // Express
    session:  RequestHandler = undefined as unknown as RequestHandler;
    sessionOptions : SessionOptions = {
        cookie: { maxAge: 86400000 }, // 24 hours
        resave: true,
        saveUninitialized: true,
        secret: 'keyboard cat'
    }
    sessionStore : Store = undefined as unknown as Store;
    webPort : number = 3000;
    classes: any = {};
    logLevel: Partial<typeof EndPointsLogging> = {};
    endPoints : Map<any, EndPoint<any, any>> = new Map();
    requests : Map<any, Request> = new Map();
    staticPaths : [string, string][] = [];
    key: string | undefined = undefined;
    cert: string | undefined = undefined;
    server : http.Server | https.Server | undefined;

    log: (message: string) => void = msg => console.log(msg);

    setLogger(log : (message: string) => void) {
        this.log = log;
    }

    setSSL(key: string, cert: string) {
        this.key = key;
        this.cert = cert;
    }

    setLogLevel(logLevel : Partial<typeof EndPointsLogging>) {
        this.logLevel = logLevel;
    }

    setPort(port : number) {
        this.webPort = port;
    }

    setSessionStore(store : Store) {
        this.sessionStore  = store;
    }

    setSessionOptions(options : Session.SessionOptions) {
        this.sessionOptions = options;
    }

    serveStatic(path : string, dir : string) {
        this.staticPaths.push([path, dir]);
    }

    createEndPoint<T, T2>(urlPrefix : any, serverClass : new () => T, clientClass : new () => T2,
                          authorizer? : (endPoint: T, method: string, args: IArguments) => Promise<boolean>, classes: any = {}) {
        this.endPoints.set(serverClass, {urlPrefix, clientClass, classes, authorizer});
    }

    start () {

        // Advertise the build for the React App (when serving in production)
        if (!this.sessionStore) {
            const MemoryStore = createMemoryStore(Session);
            this.sessionStore = new MemoryStore({
                checkPeriod: 86400000 // prune expired entries every 24h
            });
        }
        this.sessionOptions.store = this.sessionStore;

        // Setup session middleware and have app use it
        this.session = Session(this.sessionOptions);

        // On new connections
        this.app = express();

        // express middleware
        this.app.use(this.session);
        this.app.use(bodyParser.json());
        this.staticPaths.map(s => this.app.use(s[0], express.static(s[1])));

        this.server = this.cert ?
            https.createServer({
                    key: this.key,
                    cert: this.cert,
                    requestCert: false, rejectUnauthorized: false
                },
                this.app).listen(this.webPort) :
            http.createServer(this.app).listen(this.webPort);

        // Client must first connect with a post in order to receive a session id
        this.requests.forEach((request) => this.app.post(`/${request.urlPrefix}`,  async (req : any, res : any) => {
            if (this.logLevel.connect)
                this.log(`request ${request.urlPrefix} session ${req.session.id} ready for socket.io connection`);
            res.send({});
        })); // to establish session

        this.endPoints.forEach((endPoint, serverClass) => {
            this.createEndPoints(endPoint.urlPrefix, serverClass, endPoint.clientClass, endPoint.classes, endPoint.authorizer)
        });

        // Use session middleware on socket connection, passing in session details from the socket handshake
        // This bridges the gap between socket sessions and normal express sessions
        const io = new Server(this.server);
        const wrap = (session :any) => (socket : any, next : any) => session(socket.handshake, {}, next);
        io.use(wrap(this.session));

        this.io = io;

        // When connected retrieve the session info stashed in handshake and store the socket id there
        // This connects the session to the socket by socket id so it can be retrieved for calling back
        this.io.on("connection", (socket : Socket) => {
            socket.on("disconnect", (reason) => {
                if (this.logLevel.connect)
                    this.log(`Socket.io client disconnected ${socket.id} ${reason}`);
            });
            // @ts-ignore
            const session = socket.handshake.session;
            if (this.logLevel.connect)
                this.log(`Socket.io client connected to socket ${socket.id} with session ${session.id}`);
            session.socketId = socket.id;
            session.save();
        });
    }

    // Called to enumerate all sessions and allow a callback the opportunity to instantiate requests and endpoints
    // The endpoints have their data restored so that the callback can decide what to pass to the request and thus
    // send back to the browser
    async enumerateSessions<TS, TC> (cb : (
        fetchEndPoint : (serverClass : new () => TS) => TS,
        fetchRequest : (clientClass : new () => TC) => TC,
        sessionId : string,
        socketId : string) => void) {

        const sockets : any = {};
        const socketList = await this.io.fetchSockets();
        for (const socketKey in socketList) {
            const socket = socketList[socketKey];
            sockets[socket.id] = socket;
        }
        if (!this.sessionStore.all)
            throw new Error("A session store with the all method is required");

        this.sessionStore.all((err : any, sessions : any) => {

            const endPointsDef = this.endPoints;
            const expressServer = this;
            if (!err && sessions) {

                // Walk through all sessions
                for (const sid in sessions) {
                    const session = sessions[sid];

                    function fetchEndPoint <TS>(serverClass : new () => TS) {
                        const endPointDef = endPointsDef.get(serverClass);
                        if (!endPointDef)
                            throw new Error ('attempt to fetch endpoint ${serverClass?.name} that was not setup with request');
                        return expressServer.instantiateEndPoint(endPointDef.urlPrefix, session, serverClass, endPointDef.classes);
                    }

                    function fetchRequest<TC>(clientClass : new () => TC) : TC {
                        const requestWithSocket = new clientClass();
                        const socket = sockets[session.socketId];
                        (requestWithSocket as any).__socket__ = socket;
                        return requestWithSocket;
                    }

                    cb(fetchEndPoint, fetchRequest, sid, session.socketId);

                  };
            }
        });

    }

    // Called to create a request (back to the browser)
    createRequest<T>(urlPrefix : string, serverClass : new () => T, classes : any = {}) {

        this.requests.set(serverClass, {urlPrefix});

        // Go through every method in the prototype
        for (const methodName of Object.getOwnPropertyNames(serverClass.prototype)) {

            if (methodName === 'constructor' || typeof (serverClass.prototype)[methodName] !== 'function')
                continue;

            const expressServer = this;

            // Replace the method with a socket.io call (emit) back to the browser
            serverClass.prototype[methodName] =  async function (...args : any) {

                try {

                    // Gather endpoint and data
                    const endPoint = `/${urlPrefix}.${methodName}`;
                    const payload = serialize({args}, classes);

                    // Log request
                    if (expressServer.logLevel.data && expressServer.logLevel.requests)
                        expressServer.log(`Request ${endPoint} emitting with ${payload}`);
                    else if (expressServer.logLevel && expressServer.logLevel.requests)
                        expressServer.log(`Request ${endPoint} emitting`);

                    // Make requests and parse response
                    if ((this as any).__socket__)
                        (this as any).__socket__.emit(endPoint, payload);

                    // Catch any exception so it can be logged and then rethrown
                } catch (e: any) {

                    if (expressServer.logLevel.exceptions)
                        expressServer.log(e.message as string);
                    throw e;
                }
            }
            if (this.logLevel.create)
                this.log(`${urlPrefix} bound to ${serverClass.name}.${methodName}`);

        }
        return serverClass;

    }

    // Internal utility function to rehydrate an endpoint with session data saved in the request
    private instantiateEndPoint<T>(urlPrefix : string, session : any, serverClass : new () => T, classes : any) {

        if (!session)
            throw new Error('No session found - did you use express-session?');

        // Create a new class instance
        let thisEndPoint = new serverClass();

        // Find our area of the session
        if (!session.endPoints)
            session.endPoints = {};

        // Lookup class data for this endPoint and create it if needed
        if (!session.endPoints[urlPrefix])
            session.endPoints[urlPrefix] = serialize({session: (thisEndPoint as any).session}, classes);

        // Stuff instance with deserialized data
        Object.assign(thisEndPoint, deserialize(session.endPoints[urlPrefix], classes).session);

        return thisEndPoint;
    }

    // Internal function to create an endpoint on the express server
    private createEndPoints<T extends ServerEndPoints, T2>
    (urlPrefix : any, serverClass : new () => T, clientClass : new () => T2, classes : any,
     authorizer? : (endPoint: T, method: string, args: IArguments) => Promise<boolean>) {

        const log = this.log || (message => console.log(message));
        const logLevel = this.logLevel || EndPointsLogging;

        // Create an endpoint for each method in the prototype
        for (const name of Object.getOwnPropertyNames(clientClass.prototype)) {

            if (name === 'constructor')
                continue;

            const endPoint = `/${urlPrefix}.${name}`;

            this.app.post(endPoint, async (req, res) => {

                let thisEndPoint : ServerEndPoints = this.instantiateEndPoint(urlPrefix, req.session, serverClass, classes);
                const method = (thisEndPoint as any)[name];

                // handle logging
                if (logLevel.data && logLevel.calls)
                    log(`Endpoint ${name} reached with ${req.body.json} session id ${req.session.id}`);
                else if (logLevel.calls)
                    log(`Endpoint ${name} reached  session id ${req.session.id} socket id ${req.session.socketId}`);

                const requestData = req.body.json ? deserialize(req.body.json, classes) : undefined;
                try {

                    if (!method) {
                        const msg = `implementation of ${name} not defined in ${endPoint}`;
                        log(`implementation of ${name} not defined in ${endPoint}`);
                        throw new Error(msg);
                    }

                    thisEndPoint.__request__ = {
                        listenerData : {},
                        sessionId : req.session.id,
                        expressServer : this,
                        classes, urlPrefix, session: req.session
                    }

                    // Check authorization
                    if (!authorizer || await authorizer(thisEndPoint as any, name, requestData.args)) {

                        // Call the method and serialize results

                        const ret = {
                            response: await method.apply(thisEndPoint, requestData.args),
                            listenerContent: thisEndPoint.__request__.listenerData};
                        const json = serialize(ret, classes);

                        // Handle logging
                        if (logLevel.data && logLevel.calls)
                            log(`Endpoint ${name} responding with ${json}`);
                        else if (logLevel.calls)
                            log(`Endpoint ${name} responded successfully`);

                        await thisEndPoint.saveSession();

                        // Send result to client
                        res.send({json});
                    }
                } catch (e : any) {

                    // Handle logging
                    if (logLevel.calls || logLevel.exceptions)
                        log(`${endPoint} responded with exception ${e.message}`);

                    // Send exception
                    const listenerContent = thisEndPoint.__request__?.listenerData;

                    res.send({json: serialize({exception: e.message, listenerContent},classes)});

                }
                thisEndPoint.__request__ = undefined
            });

            if (logLevel.create)
                log(`${endPoint} bound to ${serverClass.name}.${name}`);

        }
    }
    async getSessionFromSessionId(sessionId : any) {
        const session : any = await new Promise ((resolve, reject) => {
            this.sessionStore.get(sessionId, (error, session) => {
                if (error)
                    reject(error)
                else
                    resolve(session);
            });
        });
        return session;
    }

    async getSocketFromSessionId(sessionId : any) {
        const session = await this.getSessionFromSessionId(sessionId);
        return this.io.sockets.sockets.get(session.socketId);
    }

    async getRequest<T>(clientClass : new () => T, sessionId : any) {
        const socket = await this.getSocketFromSessionId(sessionId);
        if (!socket)
            throw new Error(`cannot find socket for a sessionId ${sessionId}`);
        if (!this.requests.get(clientClass))
            throw new Error('invalid request class on getRequest');
        const request = new clientClass();
        (request as any).__socket__ = socket;
        return request;
    }

    async getEndPoint <TS>(serverClass : new () => TS, sessionId : any) {
        const session = await this.getSessionFromSessionId(sessionId);
        const endPointDef = this.endPoints.get(serverClass);
        if (!endPointDef)
            throw new Error ('attempt to fetch endpoint ${serverClass?.name} that was not setup with request');
        return this.instantiateEndPoint(endPointDef.urlPrefix, session, serverClass, endPointDef.classes);
    }

}

// Internal representation of an Endpoint classes saved in the ExpressServer object
// This is to allow deferred creation of the endpoints on the start() method
interface EndPoint <ServerClass, ClientClass> {
    urlPrefix: string;
    clientClass : new () => ClientClass;
    classes: any;
    authorizer : ((endPoint: ServerClass, method: string, args: IArguments) => Promise<boolean>) | undefined;
}

interface Request {
    urlPrefix: string,
}

export const EndPointsLogging = {
    create : true,
    connect : true,
    exceptions : true,
    calls : true,
    requests : false,
    data : false,
}

// Representation of an individual endpoint
// tslint:disable-next-line:max-classes-per-file
export class ServerEndPoints {
    // tslint:disable-next-line:variable-name
    __request__ : RequestData | undefined;
    getSessionId() {
        return this.__request__?.sessionId;
    }
    sendToClient(data : any) {
        if (this.__request__)
            this.__request__.listenerData = data;
    }
    getRequest<T>(clientClass : new () => T) {
        const request = this.__request__; // Data saved as part of request handling
        if (!request || !request.expressServer)
            throw new Error('internal error missing __request__ property');

        return request.expressServer.getRequest(clientClass, request.sessionId);
    }
    getEndPoint<T>(serverClass : new () => T) {
        const request = this.__request__; // Data saved as part of request handling
        if (!request || !request.expressServer)
            throw new Error('internal error missing __request__ property');
        return request.expressServer.getEndPoint(serverClass, request.sessionId);
    }
    async saveSession() {
        const request = this.__request__;
        if (!request || !request.session || !request.session.endPoints)
            throw new Error('internal error missing __request__ property');

        // Serialize the objects' session back into the session
        this.__request__ = undefined; // Data saved as part of request handling

        request.session.endPoints[request.urlPrefix] = serialize({session : this}, request.classes);
        this.__request__ = request;
        await new Promise(resolve => request.session.save(()=>resolve(undefined)));
        return;
    }
}
interface RequestData {
    listenerData : any;
    expressServer : ExpressServer;
    sessionId : any;
    classes : any;
    urlPrefix : string;
    session : Session.Session & Partial<Session.SessionData>;
}
