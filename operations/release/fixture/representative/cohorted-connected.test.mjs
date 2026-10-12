// One transport boundary regression, not an engine/load acceptance certificate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {startRampActors} from './ramp-actors-cohorted-v5.mjs';
const {WebSocketServer}=createRequire(new URL('../package.json',import.meta.url))('ws');
const tableId='11111111-1111-4111-8111-111111111111';
const ids=['22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const users=ids.map(id=>({id,session:{user:{id},access_token:'e30.'+Buffer.from(JSON.stringify({sub:id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.c2ln'}}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+4000;while(!fn()){assert.ok(Date.now()<deadline,'boundary timeout');await sleep(10);}}
test('continuous input generation drains setup then measures without clock replay or renewed lifetime',{timeout:10000},async t=>{
 let releaseJournal,enteredJournal=false,heldResponse,runner;
 const gate=new Promise(r=>releaseJournal=r),requests=[],records=[],failures=[],sockets=new Map();
 let state={table_id:tableId,hand_number:1,stage:'preflop',current_player:ids[0],action_context:'hand1:clock1',turn_start_time_ms:100,current_bet:0,pot:0,players:ids.map((id,i)=>({user_id:id,seat:i+1,stack:100,bet:0,is_folded:false,is_all_in:false}))};
 const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);requests.push(JSON.parse(Buffer.concat(chunks)));if(requests.length===1)heldResponse=res;else res.writeHead(200,{'content-type':'application/json'}).end('{"success":true}');});
 const wss=new WebSocketServer({noServer:true,handleProtocols:()=> 'bearer'});
 server.on('upgrade',(req,socket,head)=>{const offered=req.headers['sec-websocket-protocol'];const user=users.find(u=>offered.includes(u.session.access_token));assert.ok(user);wss.handleUpgrade(req,socket,head,ws=>{sockets.set(user.id,ws);ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.type==='SUBSCRIBE'){ws.send(JSON.stringify({type:'SUBSCRIBED',tableId}));ws.send(JSON.stringify({type:'SNAPSHOT',tableId,seq:requests.length?2:1,state:requests.length?{...state,turn_start_time_ms:150}:state}));}});});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 t.after(async()=>{releaseJournal();heldResponse?.end('{"success":true}');await runner?.close();for(const s of sockets.values())s.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));});
 runner=await startRampActors({tableId,users,setupFold:true,observeArrival:true,onFailure:e=>failures.push(e.message),testEndpoints:{http:'http://127.0.0.1:'+port,ws:'ws://127.0.0.1:'+port},checkpoint:async op=>{records.push(structuredClone(op));if(op.action&&op.outcome==='unknown'&&!enteredJournal){enteredJournal=true;await gate;}}});
 await sleep(450);assert.equal(requests.length,0,'arrival clock authorized action');assert.equal(enteredJournal,false,'arrival clock journaled a decision');
 for(const socket of sockets.values())socket.send(JSON.stringify({type:'DELTA',tableId,prev:1,seq:2,patch:[{op:'replace',path:'/turn_start_time_ms',value:150}]}));
 await until(()=>enteredJournal);assert.equal(requests.length,0,'HTTP preceded durable checkpoint');releaseJournal();await until(()=>requests.length===1);
 const firstKey=requests[0].idempotencyKey;assert.equal(requests[0].action,'fold');runner.quiesce();assert.throws(()=>runner.beginMeasurement(),/MEASUREMENT_PENDING_ACTION/);
 const receipt=await runner.reconnect(ids[0]);assert.equal(receipt.inflight,true);assert.equal(receipt.snapshot.spentTurns,1);assert.equal(receipt.snapshot.spentContexts,1);
 assert.equal(requests.length,1);assert.equal(requests[0].idempotencyKey,firstKey);
 heldResponse.writeHead(200,{'content-type':'application/json'}).end('{"success":true}');await until(()=>runner.observations().actions===1);const boundary=runner.beginMeasurement();assert.equal(boundary.generationRetained,true);assert.ok(boundary.remainingLifetimeMs<240000);assert.equal(runner.observations().actors[0].spentTurns,0);assert.equal(runner.observations().actors[0].totalSpentTurns,1);
 state={...state,action_context:'hand1:intermediate'};sockets.get(ids[0]).send(JSON.stringify({type:'DELTA',tableId,prev:2,seq:3,patch:[{op:'replace',path:'/action_context',value:state.action_context}]}));await sleep(450);assert.equal(requests.length,1,'spent clock was replayed after reconnect');
 sockets.get(ids[0]).send(JSON.stringify({type:'DELTA',tableId,prev:3,seq:4,patch:[{op:'replace',path:'/action_context',value:'hand1:clock2'},{op:'replace',path:'/turn_start_time_ms',value:200}]}));await until(()=>runner.observations().actions===1);runner.quiesce();assert.equal(requests.length,2);assert.notEqual(requests[1].idempotencyKey,firstKey);assert.equal(requests[1].action,'check');assert.equal(runner.observations().actors[0].spentTurns,1);assert.throws(()=>runner.beginMeasurement(),/MEASUREMENT_HANDOFF/);assert.deepEqual(failures,[]);assert.equal(records.filter(r=>r.action&&r.outcome==='returned').length,2);
});

test('two seed inputs attach a nonacting waiting observer before the positive new clock',{timeout:8000},async t=>{
 const third='44444444-4444-4444-8444-444444444444',cohort=[...users,{id:third,session:{user:{id:third},access_token:'e30.'+Buffer.from(JSON.stringify({sub:third,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.c2ln'}}];
 const requests=[],failures=[],sockets=[];let runner;
 const state={table_id:tableId,hand_number:1,stage:'preflop',current_player:ids[0],action_context:'seed:clock1',turn_start_time_ms:100,current_bet:0,pot:0,players:ids.map((id,i)=>({user_id:id,seat:i+1,stack:100,bet:0,is_folded:false,is_all_in:false}))};
 const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);requests.push({actor:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks))});res.writeHead(200,{'content-type':'application/json'}).end('{"success":true}');});
 const wss=new WebSocketServer({noServer:true,handleProtocols:()=> 'bearer'});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{sockets.push(ws);ws.on('message',raw=>{if(JSON.parse(String(raw)).type==='SUBSCRIBE'){ws.send(JSON.stringify({type:'SUBSCRIBED',tableId}));ws.send(JSON.stringify({type:'SNAPSHOT',tableId,seq:1,state}));}});}));server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 t.after(async()=>{await runner?.close();for(const s of sockets)s.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));});
 runner=await startRampActors({tableId,users:cohort,initialActorIds:ids,setupFold:true,observeArrival:true,onFailure:e=>failures.push(e.message),checkpoint:async()=>{},testEndpoints:{http:'http://127.0.0.1:'+port,ws:'ws://127.0.0.1:'+port}});
 assert.equal(sockets.length,2,'Unseated planned actor opened an unnecessary socket');assert.equal(runner.observations().actors.length,2);await sleep(450);assert.equal(requests.length,0);
 await runner.attachActors([third]);assert.equal(sockets.length,3);await assert.rejects(()=>runner.attachActors([third]),/ATTACH_ACTORS/);runner.quiesce();assert.throws(()=>runner.beginMeasurement(),/MEASUREMENT_PARTIAL_ACTORS/);await sleep(450);assert.equal(requests.length,0,'unadmitted observer authorized an action');
 for(const s of sockets)s.send(JSON.stringify({type:'DELTA',tableId,prev:1,seq:2,patch:[{op:'add',path:'/players/-',value:{user_id:third,seat:3,stack:200,bet:0,is_folded:false,is_all_in:false}}]}));state.players.push({user_id:third,seat:3,stack:200,bet:0,is_folded:false,is_all_in:false});await until(()=>runner.stateObservations().every(o=>o.state.players.some(p=>p.user_id===third)));const boundary=runner.beginMeasurement();assert.equal(boundary.generationRetained,true);await sleep(450);assert.equal(requests.length,0,'positive seat alone authorized old turn');
 for(const s of sockets)s.send(JSON.stringify({type:'DELTA',tableId,prev:2,seq:3,patch:[{op:'replace',path:'/current_player',value:third},{op:'replace',path:'/action_context',value:'seed:clock2'},{op:'replace',path:'/turn_start_time_ms',value:200}]}));await until(()=>requests.length===1);runner.quiesce();assert.equal(requests[0].actor,'Bearer '+cohort[2].session.access_token);assert.equal(requests[0].body.action,'check');assert.equal(requests[0].body.actionContext,'seed:clock2');assert.deepEqual(failures,[]);
});

// Reproduce the native initial waiting SNAPSHOT before purchased seeds are adopted.
async function seedBoundary(t, state) {
 const sockets=[],failures=[],controller=new AbortController();let runner,ready=false,refusal;
 const server=createServer((req,res)=>res.writeHead(500).end());
 const wss=new WebSocketServer({noServer:true,handleProtocols:()=> 'bearer'});
 server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{sockets.push(ws);ws.on('message',raw=>{if(JSON.parse(String(raw)).type==='SUBSCRIBE'){ws.send(JSON.stringify({type:'SUBSCRIBED',tableId}));ws.send(JSON.stringify({type:'SNAPSHOT',tableId,seq:1,state}));}});}));
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 const starting=startRampActors({tableId,users,initialActorIds:ids,setupFold:true,observeArrival:true,signal:controller.signal,onFailure:e=>failures.push(e.message),checkpoint:async()=>{},testEndpoints:{http:'http://127.0.0.1:'+port,ws:'ws://127.0.0.1:'+port}}).then(r=>{runner=r;ready=true;return r;},e=>{refusal=e;});
 t.after(async()=>{controller.abort();await starting;await runner?.close();for(const s of sockets)s.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));});
 await until(()=>sockets.length===2||refusal);await sleep(40);
 return {starting,sockets,failures,get ready(){return ready;},get refusal(){return refusal;},get runner(){return runner;}};
}
const waitingSeed=()=>({table_id:tableId,hand_number:1,stage:'waiting',current_player:null,action_context:'',turn_start_time_ms:0,turn_deadline_ms:0,turn_duration_ms:0,current_bet:0,pot:0,max_seats:2,community_cards:[],winner_ids:[],players:[]});
const seedPlayers=()=>ids.map((id,i)=>({user_id:id,seat:i+1,stack:200,bet:0,is_folded:false,is_all_in:false}));
test('empty waiting seed SNAPSHOT and singleton DELTA remain pending until both purchased seats arrive',{timeout:5000},async t=>{
 const b=await seedBoundary(t,waitingSeed());assert.equal(b.refusal,undefined);assert.equal(b.ready,false,'empty snapshot counted as ready');
 for(const s of b.sockets)s.send(JSON.stringify({type:'DELTA',tableId,prev:1,seq:2,patch:[{op:'add',path:'/players/-',value:seedPlayers()[0]}]}));
 await sleep(40);assert.equal(b.refusal,undefined);assert.equal(b.ready,false,'singleton counted as ready');
 for(const s of b.sockets)s.send(JSON.stringify({type:'DELTA',tableId,prev:2,seq:3,patch:[{op:'add',path:'/players/-',value:seedPlayers()[1]}]}));
 await b.starting;assert.equal(b.refusal,undefined);assert.equal(b.ready,true);assert.equal(b.runner.observations().actions,0);
 for(const s of b.sockets)s.send(JSON.stringify({type:'DELTA',tableId,prev:3,seq:4,patch:[{op:'replace',path:'/players',value:[]}]}));
 await until(()=>b.failures.length>0);assert.deepEqual(b.failures,['FIXTURE_ACTOR_ROSTER']);
});
for(const [name,change] of [['active hand',{stage:'preflop'}],['pot',{pot:1}],['clock',{turn_start_time_ms:1}],['board',{community_cards:['Ac']}],['wrong capacity',{max_seats:3}],['wrong seed seat',{players:[{...seedPlayers()[0],seat:2}]}],['zero seed stack',{players:[{...seedPlayers()[0],stack:0}]}]])test('pending seed refuses '+name,{timeout:5000},async t=>{
 const b=await seedBoundary(t,{...waitingSeed(),...change});await b.starting;assert.match(b.refusal?.message??'',/FIXTURE_ACTOR_/);assert.equal(b.ready,false);
});
