# express-classify

Takes the complexity out of interacting with expressjs by providing a seamless interface for classes that span the border between the browser and the nodejs server.  Methods may be implemented on the server and invoked from the browser and vica versa.  

* Complex class-based data is serialized and transported
* Complexity of managing sessions provides a context for methods
* All interaction with express, express-sessions and socket.io is encapsulated.



## Installation

```yarn add ts-crep```

or

```npm install ts-crep```





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
### Shared Code
Seamless calls between the browser and the server require that code be shared between the client project and the server project. The easiest way is to keep both projects in the same repo as subdirectories.  When using a client such as create-react-app you are obliged to keep the common code in the react project since it will not bundle files outside the project.  The Node.js side is more flexible and will   

To be continued ....


