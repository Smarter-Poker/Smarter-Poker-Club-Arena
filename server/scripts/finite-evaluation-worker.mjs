import {Worker} from 'node:worker_threads';
/** One finite offline CLI worker; no retry, watchdog or production dispatcher. */
export function runFiniteEvaluationWorker(entry,argv=[]){
 if(!(entry instanceof URL)||entry.protocol!=='file:'||!Array.isArray(argv)||argv.some(a=>typeof a!=='string'))throw TypeError('FINITE_FILE_ENTRY_AND_ARGV_REQUIRED');
 return new Promise((resolve)=>{
  let ack=null,error=null;
  const worker=new Worker(new URL('./finite-evaluation-worker-entry.mjs',import.meta.url),{workerData:{entry:entry.href},argv,execArgv:[]});
  worker.on('message',message=>{
   if(ack!==null||!message||message.kind!=='finite-evaluation-terminal'||message.isMainThread!==false||!Number.isInteger(message.exitCode)||message.exitCode<0||message.exitCode>255){error='INVALID_WORKER_TERMINAL_ACK';return;}
   ack=message;
  });
  worker.on('error',e=>{error=e.message;});
  worker.once('exit',code=>resolve({exitCode:code!==0?code:error||ack===null||ack.exitCode!==0?1:0,workerExitCode:code,acknowledged:ack!==null,error:error??(ack===null?'MISSING_WORKER_TERMINAL_ACK':null)}));
 });
}
