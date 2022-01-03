# express-classify

Takes the complexity out of interacting with expressjs by providing a seamless interface for classes that span the border between the browser and the nodejs server.  Methods may be implemented on the server and invoked from the browser and vica versa.  

* Complex class-based data is serialized and transported
* Complexity of managing sessions provides a context for methods
* All interaction with express, express-sessions and socket.io is encapsulated.



## Installation

On the server project 

```yarn add express-classify```

or

```npm install express-classify```


On the client project

```yarn add express-classify-client```

or

```npm install express-classify-client```


## Example

### Create a Request on the Client

express-classify lets you define a request interface (embodied as a class) with a set of methods that are to be implemented as Express endpoints.  Any classes passed or returned should be declared as serializable.

```typescript
class UserRequest {
    async registerUser(user : User, password : string) {}
    async login(email : string, password : string) {return value as User}
    async logout() {}
}

class User {
    first : string;
    last : string;
    email : string;
}
serializable({User});
```
Notice that the body of the UserRequest methods don't do anything and their body is purely to define the types for Typescript.  The implementation will actually be an a corresponding class in the server project that implements UserRequest
### Implement it on the Server
Then on the server you define an end point class that implements the request.  A separate instance of the class will be created automatically for each session and the instance data is effectively your session data.
```
class UserEndPoint () implements UserManager {

    user : User | undefined; // session data
    
    async registerUser(user : User, password : string) {
        const error = await userManager.register(user, password);
        if (error)
           throw new Error(error);
    }
    
    async login(email : string, password : string) {
        const user = await userManager.fetchUser(email, password);
        if (!user)
           throw new Error("invalid email or password");
        else {
            this.user = user;   
            return user;
        }
    }
    
    logout () {
        this.user = undefined;
    } 
}
serializable({UserEndPoint});
```
### Initialize the server in index.ts
```
   import {ExpressServer} from "express-classify"; 

   const server = new ExpressServer();
   server.setPort(webPort);
   server.createEndPoint("users", UserEndPoint, UserRequest);
   server.start()
```
### Initialize the client
```
   import {ExpressClient} from "express-classify-client";
   
   const userRequest expressClient.createRequest("users", new UsersRequest());
``` 
### How to Use It
ExpressClient will go through your request object and insert Axios calls to the server, serializing and transmitting all arguments.  On the way back it will deserialize the return value and re-throw any exceptions.  So you would use it like this.
```
    try {
        userRequest.login("username", "******");
    } catch (e) {
        alert (e);
    }
```
On the server you need only implement the userManager referred to by the UserEndPoints for doing the actual work of logging in, registering users etc.  And Instance of UserEndPoints will be created on each call and it's data will be serialized and deserialized from/to the session.
### Shared Code
Seamless calls between the browser and the server require that code be shared between the client project and the server project. The easiest way is to keep both projects in the same repo as subdirectories.  When using a client such as create-react-app you are obliged to keep the common code in the react project since it will not bundle files outside the project.  The Node.js side is more flexible and will   

To be continued ....


