import assert from 'node:assert/strict';
export function observeArrivalClock(actor,next){
 assert.ok(Number.isSafeInteger(next.hand_number)&&next.hand_number>=0);
 assert.ok(Number.isSafeInteger(next.turn_start_time_ms)&&next.turn_start_time_ms>=0);
 if(!actor.arrivalClock)actor.arrivalClock={hand:next.hand_number,clock:next.turn_start_time_ms};
 const old=actor.arrivalClock;assert.ok(next.hand_number>=old.hand,'arrival hand regressed');
 if(next.hand_number===old.hand&&next.turn_start_time_ms<=old.clock)return true;
 const p=next.players.find(p=>p.user_id===next.current_player);
 if(!['preflop','flop','turn','river'].includes(next.stage)||!p||p.stack<=0||p.is_folded||p.is_all_in)return true;
 actor.arrivalClock=null;actor.arrivalReady=true;return false;
}
