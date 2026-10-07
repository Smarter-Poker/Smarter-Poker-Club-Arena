import assert from 'node:assert/strict';
export function validatePublishedActor(previous,next,event){
 const p=next.players.find(p=>p.user_id===next.current_player);assert.ok(p);
 assert.ok(Number.isFinite(p.stack)&&p.stack>=0&&typeof p.is_folded==='boolean'&&typeof p.is_all_in==='boolean');
 if(p.stack>0&&!p.is_folded&&!p.is_all_in)return true;
 const old=previous?.players.find(p=>p.user_id===next.current_player);
 assert.ok(old&&previous.current_player===next.current_player&&previous.hand_number===next.hand_number&&(previous.turn_start_time_ms===next.turn_start_time_ms||(event?.stateSequence===event?.previousSequence&&Number.isSafeInteger(event?.timestamp)&&next.turn_start_time_ms>=previous.turn_start_time_ms&&next.turn_start_time_ms<=event.timestamp)),'inactive pointer is not a retained original turn');
 assert.ok(event?.type==='player_action'&&event.tableId===next.table_id&&event.handNumber===next.hand_number&&event.actorId===p.user_id&&event.replayed!==true&&Number.isSafeInteger(event.wireSequence)&&Number.isSafeInteger(event.stateSequence)&&Number.isSafeInteger(event.previousSequence)&&event.stateSequence<=event.previousSequence&&(old.is_all_in||old.is_folded||event.stateSequence===event.previousSequence),'inactive pointer lacks its actual player-action event');
 assert.ok((event.action==='all_in'&&!old.is_folded&&(old.stack>0||old.is_all_in)&&p.stack===0&&p.is_all_in&&!p.is_folded)||(event.action==='fold'&&p.is_folded&&!p.is_all_in&&p.stack===old.stack),'inactive pointer does not match the published action');
 return false;
}
