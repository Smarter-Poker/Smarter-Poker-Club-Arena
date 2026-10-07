import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertEmptyTableReady} from './independent-admissions.mjs';
// A nonacting observer only: no heartbeat, seat, funding or action request.
// GET/state can legitimately return its three-field idle fallback before a hand.
// Readiness therefore requires the real mux acknowledgement and full hub state.
export async function readEmptyTableReady({group,chairs,user,deadline,wsURL='ws://engine:8080',checkpoint=async()=>{}}){
 assert.ok(wsURL==='ws://engine:8080'||/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsURL));
 const until=Math.min(deadline,Date.now()+20000);assert.ok(until>Date.now());
 const operation={id:randomUUID(),actorId:user.id,tableId:group.tableId,route:wsURL+'/ws/multi?v=0',kind:'nonacting-empty-table-readiness',started:new Date().toISOString(),outcome:'unknown'};await checkpoint(operation);
 const socket=new WebSocket(wsURL+'/ws/multi?v=0',['bearer',user.session.access_token]);
 let ack=false,snapshot,timer;
 try{const result=await new Promise((resolve,reject)=>{
  const refuse=error=>reject(error instanceof Error?error:new Error('Empty-table socket refused'));
  timer=setTimeout(()=>refuse(new Error('EMPTY_TABLE_READINESS_TIMEOUT')),until-Date.now());
  socket.addEventListener('error',()=>refuse(new Error('EMPTY_TABLE_READINESS_TRANSPORT')));
  socket.addEventListener('close',()=>{if(!snapshot)refuse(new Error('EMPTY_TABLE_READINESS_CLOSED'));});
  socket.addEventListener('open',()=>{try{assert.equal(socket.protocol,'bearer');socket.send(JSON.stringify({type:'SUBSCRIBE',tableId:group.tableId}));}catch(error){refuse(error);}});
  socket.addEventListener('message',event=>{try{
   assert.ok(typeof event.data==='string'&&event.data.length<=2*1024*1024);const message=JSON.parse(event.data);if(message.type!=='PING')operation.lastFrame={type:message.type,tableId:message.tableId,seq:message.seq,...(message.type==='SNAPSHOT'?{state:message.state}:{})};
   if(message.type==='PING'){assert.ok(Number.isFinite(message.ts));socket.send(JSON.stringify({type:'PONG',ts:message.ts}));return;}
   assert.equal(message.tableId,group.tableId);
   if(message.type==='SUBSCRIBED'){assert.equal(ack,false);ack=true;return;}
   assert.equal(message.type,'SNAPSHOT','Empty-table initial frame refused');assert.equal(ack,true);
   assert.ok(Number.isSafeInteger(message.seq)&&message.seq>=0);assertEmptyTableReady({group,chairs,wire:message.state});
   snapshot={acknowledged:true,seq:message.seq,state:message.state,observedAt:new Date().toISOString()};resolve(snapshot);
  }catch(error){refuse(error);}});
 });operation.outcome='snapshot';operation.finished=new Date().toISOString();operation.snapshot=result;await checkpoint(operation);return result;}catch(error){operation.error=error.message;operation.finished=new Date().toISOString();await checkpoint(operation);throw error;}finally{clearTimeout(timer);socket.close();}
}
