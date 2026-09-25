// Minimal loopback startup fixture, NOT Redis qualification. No data or money is stored.
import net from "node:net";
import {once} from "node:events";
export async function startEmptyRespFixture(){
    const commands=[],sockets=new Set();
    const server=net.createServer(socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));let buffer="";
        socket.on("data",bytes=>{buffer+=bytes.toString("utf8");for(;;){
            const head=buffer.indexOf("\r\n");if(head<0)return;if(buffer[0]!=="*"){socket.destroy();return;}
            const count=Number(buffer.slice(1,head));let cursor=head+2;const args=[];
            for(let i=0;i<count;i++){const end=buffer.indexOf("\r\n",cursor);if(end<0)return;if(buffer[cursor]!=="$"){socket.destroy();return;}
                const n=Number(buffer.slice(cursor+1,end));if(buffer.length<end+2+n+2)return;args.push(buffer.slice(end+2,end+2+n));cursor=end+2+n+2;}
            buffer=buffer.slice(cursor);const command=args[0].toUpperCase();commands.push(command);
            if(command==="PING")socket.write("+PONG\r\n");
            else if(command==="CLIENT"&&["SETINFO","SETNAME"].includes(args[1]?.toUpperCase()))socket.write("+OK\r\n");
            else if(command==="SCAN")socket.write("*2\r\n$1\r\n0\r\n*0\r\n");
            else if(command==="ZRANGE")socket.write("*0\r\n");
            else if(command==="GET")socket.write("$-1\r\n");
            else if(command==="QUIT")socket.end("+OK\r\n");
            else socket.write("-ERR TEST_FIXTURE_UNSUPPORTED_COMMAND\r\n");
        }});
    });server.listen(0,"127.0.0.1");await once(server,"listening");
    return {url:`redis://127.0.0.1:${server.address().port}`,commands,async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
