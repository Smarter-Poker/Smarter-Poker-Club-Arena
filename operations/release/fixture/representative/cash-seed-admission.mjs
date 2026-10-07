import assert from 'node:assert/strict';
// Native original chair ownership precedes this observation. A missing dealer
// subset is pending, never an actionable seat or a successful admission.
export function cashSeedReady({group,chairs,wire}){
 assert.equal(chairs.length,2);assert.equal(new Set(chairs.map(c=>c.user_id)).size,2);assert.equal(new Set(chairs.map(c=>c.occupancy_id)).size,2);
 for(const [i,u] of group.users.slice(0,2).entries()){
  const c=chairs.find(c=>c.user_id===u.id);assert.ok(c);assert.equal(c.table_id,group.tableId);assert.equal(c.seat_number,i+1);assert.equal(c.left_at,null);assert.ok(Number(c.stack)>0);assert.match(c.occupancy_id,/^[0-9a-f-]{36}$/);
 }
 assert.equal(wire.table_id,group.tableId);assert.ok(Array.isArray(wire.players));assert.ok(wire.players.length<=2);assert.equal(new Set(wire.players.map(p=>p.user_id)).size,wire.players.length);
 for(const p of wire.players){const c=chairs.find(c=>c.user_id===p.user_id);assert.ok(c,'Foreign seed dealer chair');assert.equal(p.seat,c.seat_number);assert.ok(p.stack>0);}
 if(wire.players.length!==2)return false;
 assert.ok(['preflop','flop','turn','river','waiting','showdown'].includes(wire.stage));assert.ok(Number.isSafeInteger(wire.hand_number)&&wire.hand_number>=0);
 return true;
}
