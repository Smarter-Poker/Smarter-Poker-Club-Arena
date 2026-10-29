import {isMainThread,parentPort,workerData} from 'node:worker_threads';
import {register} from 'tsx/esm/api';
if(isMainThread||!parentPort)throw Error('OFFLINE_WORKER_REQUIRED');
let acknowledged=false;
process.on('beforeExit',code=>{
 if(acknowledged)return;
 acknowledged=true;
 parentPort.postMessage({kind:'finite-evaluation-terminal',isMainThread:false,exitCode:code});
});
register();
await import(workerData.entry);
