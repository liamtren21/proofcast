import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createExecutorWorker} from './executor.js';

export async function startExecutorService({env=process.env,port=Number(env.EXECUTOR_HEALTH_PORT??9122),interval=Number(env.EXECUTOR_INTERVAL_MS??5000)}={}) {
 if(!Number.isSafeInteger(port)||port<0||port>65535||!Number.isSafeInteger(interval)||interval<1000) throw new Error('INVALID_EXECUTOR_SERVICE');
 const worker=createExecutorWorker({env});
 let stopping=false,timer,flight;
 const server=http.createServer((_req,res)=>{const state=worker.snapshot();res.writeHead(state.enabled&&state.ok?200:503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(state));});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});}catch(e){await worker.close();throw e;}
 function loop(){flight=worker.tick().catch(()=>{}).finally(()=>{if(!stopping)timer=setTimeout(loop,interval);});}
 loop();
 return {url:`http://127.0.0.1:${server.address().port}`,async close(){stopping=true;clearTimeout(timer);await flight;await new Promise(resolve=>server.close(resolve));await worker.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const service=await startExecutorService();
 process.once('SIGINT',()=>void service.close());process.once('SIGTERM',()=>void service.close());
}
