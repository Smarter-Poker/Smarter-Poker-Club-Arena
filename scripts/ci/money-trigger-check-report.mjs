import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {assertProtection} from './assert-money-trigger-protection.mjs';
export const CHECK_NAME='Money trigger declaration authority';
const REPOSITORY='Smarter-Poker/Smarter-Poker-Club-Arena';
const protectionReads=new WeakMap();
// A receipt exists only in this trusted process, after both a real ruleset
// read and successful token revocation. No JSON/input/env flag can mint it.
export async function readProtectionAndRevoke({token,repository,appId,head,runId,fetchImpl=fetch,now=Date.now}){
 if(!token)throw Error('missing narrowly scoped protection reader token');
 let observedAt;
 try{
  if(repository!==REPOSITORY||!/^\d+$/.test(runId||'')||!/^[a-f0-9]{40}$/.test(head||''))throw Error('invalid protection read identity');
  const response=await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/rulesets/21163380`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`protection read failed ${response.status}`);
  assertProtection(await response.json(),appId);
  observedAt=now();
 }finally{
  // Use this token only for the fixed GET above and its own revocation.
  // The action's automatic cleanup remains enabled if this process is killed.
  const revoked=await fetchImpl('https://api.github.com/installation/token',{method:'DELETE',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(revoked.status!==204)throw Error(`protection reader revocation failed ${revoked.status}`);
 }
 const receipt=Object.freeze({});
 protectionReads.set(receipt,{repository,appId,head,runId,observedAt});
 return receipt;
}
export function completion({capturedHead,currentHead,outcome,proof,protection,runId,appId,now=Date.now()}){
 const read=protection&&typeof protection==='object'?protectionReads.get(protection):null;
 if(read)protectionReads.delete(protection);
 if(!read||read.repository!==REPOSITORY||read.head!==capturedHead||read.runId!==runId||read.appId!==appId||!Number.isFinite(read.observedAt)||now<read.observedAt||now>=read.observedAt+300000)return 'failure';
 if(outcome!=='success'||currentHead!==capturedHead||proof?.headSha!==capturedHead||proof?.runId!==runId)return 'failure';
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
  fs.writeFileSync('money-trigger-check-state.json',JSON.stringify({id:result.id,head:pr.head.sha,appId,pr:Number(number),runId:process.env.GITHUB_RUN_ID}));
 }else if(process.argv[2]==='finish'){
  if(!fs.existsSync('money-trigger-check-state.json'))throw Error('no started check; no success can be reported');
  const state=JSON.parse(fs.readFileSync('money-trigger-check-state.json'));
  const proof=fs.existsSync('money-trigger-recovery.json')?JSON.parse(fs.readFileSync('money-trigger-recovery.json')):null;
  let protection;
  try{protection=await readProtectionAndRevoke({token:process.env.PROTECTION_READER_TOKEN,repository:repo,appId,head:state.head,runId:state.runId});}
  catch{console.error('Full protection read or reader revocation failed; no success can be reported.');}
  finally{delete process.env.PROTECTION_READER_TOKEN;}
  const pr=await api(`pulls/${number}`);
  const capturedIdentity=state.runId===process.env.GITHUB_RUN_ID&&state.appId===appId&&state.pr===Number(number);
  const conclusion=completion({capturedHead:state.head,currentHead:pr.state==='open'?pr.head.sha:null,outcome:capturedIdentity?process.env.VERIFY_OUTCOME:'failure',proof,protection,runId:process.env.GITHUB_RUN_ID,appId});
  const result=await api(`check-runs/${state.id}`,'PATCH',{status:'completed',conclusion,output:{title:CHECK_NAME,summary:conclusion==='success'?'Exact captured PR-head SQL and current App-bound no-bypass main protection verified by trusted default-branch code; protection reader revoked before completion. Recovered objects matched current history, trigger and registry evidence.':'Verification failed, was canceled, became stale, or PR head advanced. No success for the new head.'}});
  if(result.head_sha!==state.head||String(result.app?.id)!==appId||result.conclusion!==conclusion)throw Error('report acknowledgement differs');
  fs.writeFileSync('money-trigger-check-result.json',JSON.stringify({head:state.head,checkId:result.id,appId:result.app.id,conclusion,name:CHECK_NAME}));
  if(conclusion!=='success')process.exitCode=1;
 }else throw Error('expected begin/finish');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
