import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {registerTournamentActor} from './tournament-adapter.mjs';
const uuid='11111111-1111-4111-8111-111111111111';
test('original registration retains actual returnedAt with one unchanged request',async t=>{
 const original=globalThis.fetch,rows=[];let calls=0,bodyFinished;
 t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,options)=>{calls++;assert.match(url,/fn_register_for_tournament_request$/);assert.deepEqual(JSON.parse(options.body),{p_tournament_id:uuid,p_request_id:uuid});return {status:200,ok:true,text:async()=>{await new Promise(r=>setTimeout(r,15));bodyFinished=Date.now();return JSON.stringify({ok:true,registration_id:uuid,request_id:uuid});}};};
 const token='e30.'+Buffer.from(JSON.stringify({sub:uuid,role:'authenticated',exp:Date.now()/1000+3600})).toString('base64url')+'.sig';
 await registerTournamentActor({tournamentId:uuid,user:{id:uuid,session:{access_token:token}},requestId:uuid,anonKey:'synthetic',checkpoint:async row=>rows.push(structuredClone(row))});
 assert.equal(calls,1);assert.equal(rows.length,2);assert.equal(rows[0].phase,'unknown');assert.equal(rows[0].returnedAt,undefined);assert.equal(rows[1].phase,'returned');assert.equal(rows[1].started,rows[0].started);assert.ok(Date.parse(rows[1].returnedAt)>=bodyFinished);assert.ok(Date.parse(rows[1].returnedAt)>=Date.parse(rows[0].started));
});
test('common original activation deadline is durably observed before final registrations',async()=>{
 const source=await readFile(new URL('./ramp-run-cohorted-v5.mjs',import.meta.url),'utf8');
 const start=source.indexOf('const activationDeadline=Date.now()+20000;'),end=source.indexOf('// Complete each final tournament',start);assert.ok(start>=0&&end>start);
 const recorded=[],result={},state={attempt:14},size=600;
 const deadline=Function('append','result','state','size',source.slice(start,end)+'return activationDeadline;')((...args)=>recorded.push(args),result,state,size);
 assert.equal(recorded.length,1);assert.equal(recorded[0][1].activationDeadlineMs,deadline);assert.equal(result.activationDeadlineMs,deadline);assert.equal(recorded[0][1].startupBudgetMs,20000);assert.match(source,/Date.now\(\)<activationDeadline,'coherent tournament seating exceeded cohort budget'/);
});
test('board ending refusal retains original connected evidence before propagating unchanged failure',async()=>{
 const source=await readFile(new URL('./ramp600-lifecycle-actors-relocation-current-v2.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function boardEnd('),end=source.indexOf('async function acceptState(',start);assert.ok(start>=0&&end>start);
 const original=new Error('no witnessed relocation'),result={transitions:[]},after={tournament:{id:uuid}},a={tableId:uuid,user:{id:uuid},boardWitness:{original:true},boundary:{handNumber:7},lastGameplay:{sequence:8}},settled={postCommitOk:true};let persists=0;
 const fn=Function('read','committed','validateBoardTransition','result','persist','assert',source.slice(start,end)+'return boardEnd;')(async()=>after,async()=>settled,()=>{throw original;},result,async()=>{persists++;},assert);
 await assert.rejects(fn(a,{count:1}),e=>e===original);
 assert.equal(persists,1);assert.equal(result.boardEndRefusals.length,1);const w=result.boardEndRefusals[0];assert.equal(w.tableId,uuid);assert.equal(w.actorId,uuid);assert.deepEqual(w.before,a.boardWitness);assert.deepEqual(w.after,after);assert.deepEqual(w.boundary,a.boundary);assert.deepEqual(w.lastGameplay,a.lastGameplay);assert.deepEqual(w.settledHand,settled);assert.equal(w.reason,original.message);
 assert.doesNotMatch(JSON.stringify(w),/access_token|authorization|serviceKey/);
});
