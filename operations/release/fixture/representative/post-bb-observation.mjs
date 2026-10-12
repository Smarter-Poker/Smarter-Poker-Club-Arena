import assert from 'node:assert/strict';
// This only witnesses a natural entry transition. It never turns the refused
// original post into a success and never authorizes an action or another POST.
export function witnessNaturalBlindEntry({before,after,wire,userId,tableId,result}) {
 assert.equal(result?.success,false);assert.equal(result.error,'Player is not waiting for BB');
 assert.equal(before.user_id,userId);assert.equal(before.table_id,tableId);assert.equal(before.left_at,null);assert.ok(Number(before.stack)>0);assert.equal(before.entry_hold,'waiting');assert.equal(before.entry_post_agreed,false);
 assert.equal(after.user_id,userId);assert.equal(after.table_id,tableId);assert.equal(after.occupancy_id,before.occupancy_id);assert.equal(after.left_at,null);assert.ok(Number(after.stack)>0);assert.ok(after.entry_hold===null||after.entry_hold==='posting');
 assert.equal(wire.table_id,tableId);assert.ok(['preflop','flop','turn','river','showdown','waiting'].includes(wire.stage));assert.ok(Number.isSafeInteger(wire.hand_number)&&wire.hand_number>0);
 const own=wire.players.filter(p=>p.user_id===userId);assert.equal(own.length,1);assert.equal(own[0].seat,after.seat_number);assert.ok(own[0].stack>0);
 return {kind:'natural-entry-observation',operationAccepted:false,mayAct:false,repeatPost:false,before,after,wire,result};
}


// Native funding precedes the dealer's waiting-set adoption. Read-only setup
// observation uses the existing caller deadline and never sends a retry.
export async function awaitPostAgreementReadiness({before,userId,tableId,readNative,readWire,deadline,checkFailure=()=>{},observe=()=>{}}) {
 assert.equal(before.user_id,userId);assert.equal(before.table_id,tableId);
 assert.equal(before.left_at,null);assert.ok(Number(before.stack)>0);
 assert.equal(before.entry_hold,'waiting');assert.equal(before.entry_post_agreed,false);
 assert.ok(Number.isFinite(deadline));
 let pendingRecorded=false;
 while(Date.now()<deadline){
  checkFailure();
  const chair=await readNative();
  assert.ok(chair);assert.equal(chair.user_id,userId);assert.equal(chair.table_id,tableId);
  assert.equal(chair.occupancy_id,before.occupancy_id);assert.equal(chair.seat_number,before.seat_number);
  assert.equal(chair.left_at,null);assert.ok(Number(chair.stack)>0);
  if(chair.entry_hold!== 'waiting'||chair.entry_post_agreed!==false){
   assert.ok(chair.entry_hold===null||chair.entry_hold==='posting'||(chair.entry_hold==='waiting'&&chair.entry_post_agreed===true));
   const evidence={phase:'released-before-post',operationSent:false,actorId:userId,tableId,before,after:chair};
   await observe(evidence);return evidence;
  }
  const wire=await readWire();checkFailure();assert.ok(Date.now()<deadline,'Original post-entry readiness deadline exceeded');assert.ok(wire);assert.equal(wire.table_id,tableId);
  assert.ok(['idle','waiting','preflop','flop','turn','river','showdown'].includes(wire.stage));
  assert.ok(Array.isArray(wire.players));
  const waiting=wire.waiting_for_bb_user_ids;
  if(wire.stage==='idle')assert.ok(wire.players.length===0&&(!Array.isArray(waiting)||waiting.length===0));
  if(Array.isArray(waiting)&&waiting.includes(userId)){
   assert.equal(new Set(waiting).size,waiting.length);
   assert.ok(wire.players.length>=2&&wire.players.every(p=>Number(p.stack)>=0));
   const own=wire.players.filter(p=>p.user_id===userId);assert.ok(own.length<=1);
   if(wire.stage==='waiting')assert.equal(own.length,1);
   if(own.length){assert.equal(own[0].seat,chair.seat_number);assert.ok(Number(own[0].stack)>0);}
   const evidence={phase:'engine-waiting-post-ready',operationSent:false,actorId:userId,tableId,before:chair,wire};
   await observe(evidence);assert.ok(Date.now()<deadline,'Original post-entry readiness deadline exceeded');return evidence;
  }
  if(!pendingRecorded){await observe({phase:'native-entry-awaits-engine',operationSent:false,actorId:userId,tableId,before:chair,wire});pendingRecorded=true;}
  await new Promise(resolve=>setTimeout(resolve,Math.min(50,Math.max(1,deadline-Date.now()))));
 }
 throw new Error('Original post-entry readiness deadline exceeded');
}
