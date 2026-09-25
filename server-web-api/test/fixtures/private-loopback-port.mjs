import net from "node:net";
// Linux can preferentially allocate listen(0) from the lower ephemeral half.
// Select an explicit controller-range port with bounded collision retries.
export async function privateLoopbackPort(){
    for(let attempt=0;attempt<128;attempt++){
        const port=49152+Math.floor(Math.random()*16000),server=net.createServer();
        const error=await new Promise(resolve=>{server.once("error",resolve);server.listen(port,"127.0.0.1",()=>resolve(null));});
        if(error){if(error.code==="EADDRINUSE"||error.code==="EACCES")continue;throw error;}
        await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));return port;
    }
    throw new Error("TEST_PRIVATE_PORT_EXHAUSTED");
}
