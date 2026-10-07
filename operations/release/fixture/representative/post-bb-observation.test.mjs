import test from 'node:test';import assert from 'node:assert/strict';import {witnessNaturalBlindEntry} from './post-bb-observation.mjs';
const before={user_id:'user',table_id:'table',occupancy_id:'original',seat_number:4,left_at:null,stack:200,entry_hold:'waiting',entry_post_agreed:false};const after={...before,entry_hold:null};const wire={table_id:'table',stage:'preflop',hand_number:1,players:[{user_id:'user',seat:4,stack:198}]};const result={success:false,error:'Player is not waiting for BB'};const x={before,after,wire,userId:'user',tableId:'table',result};
test('ordinary natural entry race preserves false result and remains nonacting',()=>{const p=witnessNaturalBlindEntry(x);assert.equal(p.result.success,false);assert.equal(p.operationAccepted,false);assert.equal(p.mayAct,false);assert.equal(p.repeatPost,false);});
test('foreign occupancy, still waiting, absent dealer, other refusal or seat cannot substitute',()=>{for(const change of [{after:{...after,occupancy_id:'foreign'}},{after:before},{wire:{...wire,players:[]}},{wire:{...wire,players:[{user_id:'user',seat:5,stack:198}]}},{result:{success:false,error:'unrelated failure'}}])assert.throws(()=>witnessNaturalBlindEntry({...x,...change}));});

import fs from 'node:fs';
import * as observation from './post-bb-observation.mjs';
const driver=fs.readFileSync(new URL('./ramp-run-cohorted-v5.mjs',import.meta.url),'utf8');
function actualAgreement({readNative,readWire,sendPost,checkpoint,deadline=Date.now()+1000}){
 const begin=driver.indexOf(' async function agreeToPost('),end=driver.indexOf(' async function attachSeedObserver(',begin);
 assert.ok(begin>0&&end>begin);
 const seededObservers=new Map([[0,{stateObservations:()=>[{state:readWire()}]}]]);
 const append=(name,value)=>checkpoint({name,...value});
 const request=async()=>sendPost();
 const fn=new Function('assert','seededObservers','request','append','size','state','requestDeadline','setupObserverFailure','awaitPostAgreementReadiness','witnessNaturalBlindEntry','fetch','return '+driver.slice(begin,end).trim())(
 assert,seededObservers,request,append,600,{attempt:13},deadline,null,observation.awaitPostAgreementReadiness,observation.witnessNaturalBlindEntry,async()=>({ok:true,json:async()=>readWire()}));
 const u={id:'user',session:{access_token:'synthetic'}},group={index:0,tableId:'table'};
 return {u,run:()=>fn(group,u,before,async()=>[await readNative()])};
}
const waitingWire={...wire,stage:'waiting',players:[{user_id:'user',seat:4,stack:200},{user_id:'seed',seat:1,stack:200}],waiting_for_bb_user_ids:['user']};
test('actual setup caller waits for engine waiting identity before its one POST',async()=>{
 let sends=0,adopted=false;const receipts=[];
 const a=actualAgreement({readNative:async()=>before,readWire:()=>({...waitingWire,waiting_for_bb_user_ids:adopted?['user']:[]}),sendPost:async()=>{sends++;return{success:true};},checkpoint:r=>receipts.push(structuredClone(r))});
 const pending=a.run();await new Promise(r=>setTimeout(r,10));assert.equal(sends,0,'Native-only entry must not send before engine adoption');adopted=true;await pending;assert.equal(sends,1);assert.equal(a.u.setupPostAgreement.result.success,true);
});
test('actual setup caller sends nothing if native entry releases before engine adoption',async()=>{
 let sends=0;const receipts=[];const a=actualAgreement({readNative:async()=>after,readWire:()=>({...waitingWire,waiting_for_bb_user_ids:[]}),sendPost:async()=>{sends++;return{success:true};},checkpoint:r=>receipts.push(structuredClone(r))});
 await a.run();assert.equal(sends,0);assert.equal(a.u.setupPostAgreement,undefined);assert.ok(receipts.some(r=>r.phase==='released-before-post'&&r.operationSent===false));
});
test('actual failed post witness retains original raw idle frame before refusing',async()=>{
 let sends=0;const receipts=[];let posted=false;const idle={table_id:'table',stage:'idle',players:[]};
 const a=actualAgreement({readNative:async()=>posted?after:before,readWire:()=>posted?idle:waitingWire,sendPost:async()=>{sends++;posted=true;return result;},checkpoint:r=>receipts.push(structuredClone(r))});
 await assert.rejects(a.run(),error=>{assert.equal(error.code,'ERR_ASSERTION',error.stack);return true;});assert.equal(sends,1);assert.ok(receipts.some(r=>r.naturalObservation?.wire.stage==='idle'&&r.naturalObservation.result.success===false));assert.equal(a.u.setupPostAgreement.result.success,false);
});
test('actual unknown original post remains unknown and is never retried',async()=>{
 let sends=0;const receipts=[];const a=actualAgreement({readNative:async()=>before,readWire:()=>waitingWire,sendPost:async()=>{sends++;throw Error('unknown transport');},checkpoint:r=>receipts.push(structuredClone(r))});
 await assert.rejects(a.run(),/unknown transport/);assert.equal(sends,1);assert.equal(a.u.setupPostAgreement.outcome,'unknown');assert.equal(receipts.filter(r=>r.outcome==='unknown').length,1);
});

test('actual caller refuses a repeated unknown operation without another send',async()=>{
 let sends=0;const a=actualAgreement({readNative:async()=>before,readWire:()=>waitingWire,sendPost:async()=>{sends++;throw Error('unknown transport');},checkpoint:()=>{}});
 await assert.rejects(a.run(),/unknown transport/);await assert.rejects(a.run(),/Existing original/);assert.equal(sends,1);
});
test('entry deadline expiry during native read sends zero posts',async()=>{
 let sends=0;const a=actualAgreement({readNative:async()=>{await new Promise(r=>setTimeout(r,15));return before;},readWire:()=>waitingWire,sendPost:async()=>{sends++;return{success:true};},checkpoint:()=>{},deadline:Date.now()+5});
 await assert.rejects(a.run(),/deadline exceeded/);assert.equal(sends,0);
});
test('entry readiness requires exact occupancy and authoritative waiting identity',async()=>{
 for(const change of [{readNative:async()=>({...before,occupancy_id:'foreign'}),readWire:()=>waitingWire},{readNative:async()=>before,readWire:()=>({...waitingWire,table_id:'foreign'})},{readNative:async()=>before,readWire:()=>({...waitingWire,players:[{user_id:'seed',seat:1,stack:200}]})}]){
 let sends=0;const a=actualAgreement({...change,sendPost:async()=>{sends++;return{success:true};},checkpoint:()=>{}});await assert.rejects(a.run());assert.equal(sends,0);
 }
});
test('active hand waiting set includes held joiner even when live roster omits own seat',async()=>{
 let sends=0;const a=actualAgreement({readNative:async()=>before,readWire:()=>({...waitingWire,stage:'preflop',players:[{user_id:'seed1',seat:1,stack:200},{user_id:'seed2',seat:2,stack:200}]}),sendPost:async()=>{sends++;return{success:true};},checkpoint:()=>{}});
 await a.run();assert.equal(sends,1);
});
