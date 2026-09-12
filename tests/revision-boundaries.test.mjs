import {test} from 'node:test';import assert from 'node:assert/strict';
import {completion} from '../scripts/ci/money-trigger-check-report.mjs';
import {validProof} from '../scripts/ci/money-trigger-proof.mjs';
import {coordinate} from '../scripts/ci/await-money-trigger-proof.mjs';
const time=1000000,head='a'.repeat(40);
const proof=()=>({headSha:head,results:[{recovered:true,path:'supabase/migrations/20260101000000_x.sql',sha256:'a'.repeat(64)}],catalogObservedAt:new Date(time).toISOString(),expiresAt:new Date(time+300000).toISOString()});
for(const outcome of ['failure','cancelled','skipped',''])test('report '+outcome+' cannot grant success',()=>assert.equal(completion({capturedHead:head,currentHead:head,outcome,proof:proof(),now:time}),'failure'));
test('head advance cannot grant new head success',()=>assert.equal(completion({capturedHead:head,currentHead:'b'.repeat(40),outcome:'success',proof:proof(),now:time}),'failure'));
test('exact current head can succeed',()=>assert.equal(completion({capturedHead:head,currentHead:head,outcome:'success',proof:proof(),now:time}),'success'));
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
