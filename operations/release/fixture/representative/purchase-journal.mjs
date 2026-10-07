import assert from 'node:assert/strict';
// Recovery only adopts acknowledged original purchases. Unknown or refused writes
// remain blocked for native durable readback; this helper never sends a request.
export function recoverPurchases(state, rows) {
 const latest=new Map();
 for(const op of rows){const key=op.requestId??op.id;assert.ok(key);latest.set(key,op);}
 for(const group of state.groups)for(const user of group.users){
  const candidates=[...latest.values()].filter(op=>group.kind==='cash'
   ?op.label==='atomic_table_buyin'&&op.requestIdentity?.p_idempotency_key===user.buyinOp
   :op.requestId===user.registrationOp);
  for(const op of candidates){
   if(group.kind==='cash'){
    const b=op.requestIdentity;assert.equal(b.p_user_id,user.id);assert.equal(b.p_table_id,group.tableId);assert.equal(b.p_club_id,group.clubId);
    assert.equal(op.outcome,'returned','Unknown original buy-in requires native readback');assert.ok((op.httpStatus===204&&op.result===null)||(op.httpStatus===200&&op.result&&op.result.ok!==false&&op.result.success!==false),'Refused or malformed original buy-in must not replay');user.buyinEntered=true;
   }else{
    assert.equal(op.actorId,user.id);assert.equal(op.tournamentId,group.tournamentId);assert.equal(op.phase,'returned','Unknown original entry requires native readback');assert.equal(op.httpStatus,200,'Refused original entry must not replay');assert.equal(op.result?.ok,true);assert.ok(op.result.registration_id);if(op.result.request_id!==undefined)assert.equal(op.result.request_id,user.registrationOp);user.registered=true;
   }
  }
 }
 return state;
}
