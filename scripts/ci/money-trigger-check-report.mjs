import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
export const CHECK_NAME='Money trigger declaration authority';
export function completion({capturedHead,currentHead,outcome,proof,now=Date.now()}){
 if(outcome!=='success'||currentHead!==capturedHead||proof?.headSha!==capturedHead)return 'failure';
 if(proof.results.some(x=>x.recovered)){
  const observed=Date.parse(proof.catalogObservedAt),expiry=Date.parse(proof.expiresAt);
  if(!Number.isFinite(observed)||expiry!==observed+300000||now<observed||now>=expiry)return 'failure';
 }
 return 'success';
}
async function main(){
 const repo=process.env.GITHUB_REPOSITORY,number=process.env.PR_NUMBER,appId=process.env.REPORTER_APP_ID;
 if(repo!=='Smarter-Poker/Smarter-Poker-Club-Arena'||!/^\d+$/.test(number||'')||!/^\d+$/.test(appId||''))throw Error('invalid reporting identity');
 const token=process.env.REPORTER_TOKEN;if(!token)throw Error('missing restricted reporter token');
 async function api(p,method='GET',body){const r=await fetch(`https://api.github.com/repos/${repo}/${p}`,{method,headers:{Authorization:`Bearer ${method==='GET'?process.env.GITHUB_TOKEN:token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(`reporting failed ${r.status}`);return r.json()}
 if(process.argv[2]==='begin'){
  const pr=await api(`pulls/${number}`);if(pr.state!=='open'||pr.base.ref!=='main')throw Error('invalid PR state');
  const result=await api('check-runs','POST',{name:CHECK_NAME,head_sha:pr.head.sha,status:'in_progress',external_id:`money-trigger-${process.env.GITHUB_RUN_ID}`,details_url:`https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`});
  if(result.head_sha!==pr.head.sha||String(result.app?.id)!==appId)throw Error('wrong check source/head');
  fs.writeFileSync('money-trigger-check-state.json',JSON.stringify({id:result.id,head:pr.head.sha,appId,pr:Number(number)}));
 }else if(process.argv[2]==='finish'){
  if(!fs.existsSync('money-trigger-check-state.json'))throw Error('no started check; no success can be reported');
  const state=JSON.parse(fs.readFileSync('money-trigger-check-state.json'));const pr=await api(`pulls/${number}`);
  const proof=fs.existsSync('money-trigger-recovery.json')?JSON.parse(fs.readFileSync('money-trigger-recovery.json')):null;
  const conclusion=completion({capturedHead:state.head,currentHead:pr.state==='open'?pr.head.sha:null,outcome:process.env.VERIFY_OUTCOME,proof});
  const result=await api(`check-runs/${state.id}`,'PATCH',{status:'completed',conclusion,output:{title:CHECK_NAME,summary:conclusion==='success'?'Exact captured PR-head SQL verified by trusted default-branch code; recovered objects matched current history, trigger and registry evidence.':'Verification failed, was canceled, became stale, or PR head advanced. No success for the new head.'}});
  if(result.head_sha!==state.head||String(result.app?.id)!==appId||result.conclusion!==conclusion)throw Error('report acknowledgement differs');
  fs.writeFileSync('money-trigger-check-result.json',JSON.stringify({head:state.head,checkId:result.id,appId:result.app.id,conclusion,name:CHECK_NAME}));
  if(conclusion!=='success')process.exitCode=1;
 }else throw Error('expected begin/finish');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
