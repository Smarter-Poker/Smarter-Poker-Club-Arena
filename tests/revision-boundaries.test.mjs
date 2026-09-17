import {test} from 'node:test';import assert from 'node:assert/strict';
import {completion,readProtectionAndRevoke} from '../scripts/ci/money-trigger-check-report.mjs';
import {validProof} from '../scripts/ci/money-trigger-proof.mjs';
import {coordinate} from '../scripts/ci/await-money-trigger-proof.mjs';
const time=1000000,head='a'.repeat(40);
const proof=()=>({headSha:head,runId:'1234',results:[{recovered:true,path:'supabase/migrations/20260101000000_x.sql',sha256:'a'.repeat(64)}],catalogObservedAt:new Date(time).toISOString(),expiresAt:new Date(time+300000).toISOString()});
const repository='Smarter-Poker/Smarter-Poker-Club-Arena',runId='1234',appId='4962039';
const protectedRule=()=>({target:'branch',enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'Money trigger declaration authority',integration_id:4962039}]}}]});
async function freshProtection(options={}){
 return readProtectionAndRevoke({token:'modeled-reader-token',repository,appId,head,runId,now:()=>time,fetchImpl:async(url,init)=>init.method==='DELETE'?{status:204}:{ok:true,json:async()=>protectedRule()},...options});
}
const complete=(protection,extra={})=>completion({capturedHead:head,currentHead:head,outcome:'success',proof:proof(),now:time,runId,appId,protection,...extra});
for(const outcome of ['failure','cancelled','skipped',''])test('report '+outcome+' cannot grant success',async()=>assert.equal(complete(await freshProtection(),{outcome}),'failure'));
test('head advance cannot grant new head success',async()=>assert.equal(complete(await freshProtection(),{currentHead:'b'.repeat(40)}),'failure'));
test('exact current head can succeed',async()=>assert.equal(complete(await freshProtection()),'success'));
test('successful SQL alone cannot certify missing full protection',()=>assert.equal(completion({capturedHead:head,currentHead:head,outcome:'success',proof:proof(),now:time}),'failure'));
for(const protection of [true,{}, {verified:true,head,runId,appId,observedAt:time}])test('caller supplied protection cannot mint authority '+JSON.stringify(protection),()=>assert.equal(complete(protection),'failure'));
for(const extra of [{runId:'another-run'},{appId:'123'},{capturedHead:'b'.repeat(40)},{now:time-1},{now:time+300000}])test('protection identity/freshness mismatch refuses '+JSON.stringify(extra),async()=>assert.equal(complete(await freshProtection(),extra),'failure'));
test('a live protection receipt cannot be reused',async()=>{const receipt=await freshProtection();assert.equal(complete(receipt),'success');assert.equal(complete(receipt),'failure')});
test('catalog expiry still prevents completion with fresh protection',async()=>assert.equal(complete(await freshProtection({now:()=>time+300000}),{now:time+300000}),'failure'));
test('catalog forged extended expiry still prevents completion',async()=>{const p=proof();p.expiresAt=new Date(time+600000).toISOString();assert.equal(complete(await freshProtection(),{proof:p}),'failure')});
test('SQL proof from another run cannot complete current check',async()=>assert.equal(complete(await freshProtection(),{proof:{...proof(),runId:'5678'}}),'failure'));
test('protection read uses only fixed GET and token self-revocation before authority exists',async()=>{
 const calls=[];const receipt=await freshProtection({fetchImpl:async(url,init)=>{
  calls.push({url,method:init.method||'GET',authorization:init.headers.Authorization});
  return init.method==='DELETE'?{status:204}:{ok:true,json:async()=>protectedRule()};
 }});
 assert.deepEqual(calls,[{url:`https://api.github.com/repos/${repository}/rulesets/21163380`,method:'GET',authorization:'Bearer modeled-reader-token'},{url:'https://api.github.com/installation/token',method:'DELETE',authorization:'Bearer modeled-reader-token'}]);
 assert.equal(complete(receipt),'success');
});
for(const kind of ['read-denied','read-throws','bad-json','hidden-bypass','nonempty-bypass','missing-context','revoke-denied','revoke-throws'])test('full protection failure refuses and attempts token revocation: '+kind,async()=>{
 const calls=[];
 await assert.rejects(freshProtection({fetchImpl:async(url,init)=>{
  calls.push(init.method||'GET');
  if(init.method==='DELETE'){
   if(kind==='revoke-throws')throw Error('modeled transport failure');
   return {status:kind==='revoke-denied'?403:204};
  }
  if(kind==='read-throws')throw Error('modeled transport failure');
  return {ok:kind!=='read-denied',status:403,json:async()=>{
   if(kind==='bad-json')throw Error('modeled malformed response');
   const r=protectedRule();if(kind==='hidden-bypass')delete r.bypass_actors;
   if(kind==='nonempty-bypass')r.bypass_actors=[{actor_id:1}];
   if(kind==='missing-context')r.rules=[];return r;
  }};
 }}));
 assert.deepEqual(calls,['GET','DELETE']);
});
test('missing minted reader cannot produce protection',async()=>assert.rejects(freshProtection({token:''}),/missing/));
function pair(now,produced=time+299000){return {run:{id:1,repository:{full_name:'r'},path:'.github/workflows/money-trigger-recovery.yml',event:'workflow_dispatch',head_branch:'main',conclusion:'success',updated_at:new Date(now).toISOString()},x:{...proof(),version:1,repository:'r',runId:'1',pr:null,producedAt:new Date(produced).toISOString(),recordHashes:{}},ctx:{repo:'r',head,now}}}
test('producer299s plus consumer299s cannot renew expiry',()=>{const p=pair(time+598000);assert.equal(validProof(p.run,p.x,p.ctx),false)});
test('catalog just inside300s accepted',()=>{const p=pair(time+299999);assert.equal(validProof(p.run,p.x,p.ctx),true)});
test('catalog exactly300s refused',()=>{const p=pair(time+300000);assert.equal(validProof(p.run,p.x,p.ctx),false)});
test('forged extended expiry refused',()=>{const p=pair(time+299999);p.x.expiresAt=new Date(time+600000).toISOString();assert.equal(validProof(p.run,p.x,p.ctx),false)});
function deps(){let t=0,requests=0,reads=0;return {now:()=>t,head:async()=>head,requestId:()=>String(++requests),dispatch:async()=>{},sleep:async ms=>{t+=ms},findRun:async()=>++reads<3?{status:'in_progress'}:{id:requests,status:'completed',conclusion:'success'},consume:async()=>true,requests:()=>requests}}
test('first lookup before completion waits',async()=>{const d=deps();await coordinate(d);assert.equal(d.now(),10000)});
test('expired same-head proof dispatches fresh read',async()=>{const d=deps();let c=0;d.consume=async()=>++c===2;await coordinate(d);assert.equal(d.requests(),2)});
test('slow queue bounded deadline fails',async()=>{const d=deps();d.findRun=async()=>({status:'queued'});await assert.rejects(coordinate(d,{deadlineMs:12000}),/deadline/);assert.equal(d.now(),12000)});
test('head advance while waiting refuses',async()=>{const d=deps();d.head=async()=>d.now()>0?'b'.repeat(40):head;await assert.rejects(coordinate(d),/advanced/)});
test('cancelled producer refuses',async()=>{const d=deps();d.findRun=async()=>({status:'completed',conclusion:'cancelled'});await assert.rejects(coordinate(d),/did not succeed/)});
test('bounded refresh does not loop forever',async()=>{const d=deps();d.consume=async()=>false;await assert.rejects(coordinate(d),/bounded refresh/);assert.equal(d.requests(),3)});
test('consume past deadline cannot succeed',async()=>{const d=deps();d.consume=async()=>{await d.sleep(600000);return true};await assert.rejects(coordinate(d),/deadline/)});

// Regression: a successful consumer must not authorize a different current HEAD.
test('head advance during successful consume refuses',async()=>{const d=deps();let current=head;d.head=async()=>current;d.consume=async()=>{current='b'.repeat(40);return true};await assert.rejects(coordinate(d),/advanced during proof consumption/)});
test('head advance during failed consume refuses before refresh',async()=>{const d=deps();let current=head;d.head=async()=>current;d.consume=async()=>{current='b'.repeat(40);return false};await assert.rejects(coordinate(d),/advanced during proof consumption/);assert.equal(d.requests(),1)});
