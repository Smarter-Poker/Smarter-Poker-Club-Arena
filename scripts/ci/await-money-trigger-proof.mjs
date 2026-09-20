import {randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
// A measured ~10-minute hosted queue exhausted the former total budget after
// successful verification. Allow that queue, the workflow's 10-minute execution
// limit and one minute for authenticated artifact consumption. Catalog proofs
// still expire five minutes after observation; no timestamp is renewed here.
export async function coordinate(d,{deadlineMs=21*60*1000,pollMs=5000,maxAttempts=3}={}){
 const started=d.now(),head=await d.head();
 for(let attempt=0;attempt<maxAttempts;attempt++){
  if(d.now()-started>=deadlineMs)throw Error('proof deadline exceeded');
  if(await d.head()!==head)throw Error('local head advanced');
  const request=d.requestId();await d.dispatch(request);
  let run;
  while(d.now()-started<deadlineMs){
   if(await d.head()!==head)throw Error('local head advanced');
   run=await d.findRun(request);
   if(run?.status==='completed')break;
   await d.sleep(Math.min(pollMs,deadlineMs-(d.now()-started)));
  }
  if(!run||run.status!=='completed')throw Error('proof deadline exceeded');
  if(run.conclusion!=='success')throw Error('trusted producer did not succeed');
  if(await d.head()!==head)throw Error('local head advanced');
  if(d.now()-started>=deadlineMs)throw Error('proof deadline exceeded');
  const consumed=await d.consume(run.id);
  if(d.now()-started>=deadlineMs)throw Error('proof deadline exceeded');
  if(await d.head()!==head)throw Error('local head advanced during proof consumption');
  if(d.now()-started>=deadlineMs)throw Error('proof deadline exceeded');
  if(consumed)return;
  // Same exact head, new dispatch and new catalog read. Never renew old proof timestamps.
 }
 throw Error('fresh proof unavailable after bounded refresh');
}
async function main(){
 const repo='Smarter-Poker/Smarter-Poker-Club-Arena',dir=new URL('./',import.meta.url);
 const gh=(args,input)=>execFileSync('gh',args,{input,encoding:'utf8',maxBuffer:6000000,timeout:30000});
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
 await coordinate({now:Date.now,head:async()=>git('rev-parse','HEAD'),requestId:randomUUID,sleep:ms=>new Promise(r=>setTimeout(r,ms)),
  dispatch:async request=>{
   const bundle=execFileSync(process.execPath,[fileURLToPath(new URL('make-money-trigger-bundle.mjs',dir)),process.env.MONEY_TRIGGER_BASE||'origin/main'],{encoding:'utf8',maxBuffer:100000,timeout:30000}).trim();
   gh(['api',`repos/${repo}/actions/workflows/money-trigger-recovery.yml/dispatches`,'--method','POST','--input','-'],JSON.stringify({ref:'main',inputs:{candidate_bundle:bundle,request_id:request}}));
  },
  findRun:async request=>{const data=JSON.parse(gh(['api',`repos/${repo}/actions/workflows/money-trigger-recovery.yml/runs?event=workflow_dispatch&per_page=100`]));const rows=data.workflow_runs.filter(r=>r.display_title===`Money trigger proof ${request}`&&r.head_branch==='main');if(rows.length>1)throw Error('ambiguous dispatch');return rows[0]},
  consume:async id=>spawnSync(process.execPath,[fileURLToPath(new URL('consume-money-trigger-recovery.mjs',dir))],{stdio:'inherit',env:{...process.env,MONEY_TRIGGER_RUN_ID:String(id)},timeout:30000}).status===0
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
