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
