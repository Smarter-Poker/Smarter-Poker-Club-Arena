import assert from 'node:assert/strict';
const betting=new Set(['preflop','flop','turn','river']);
// Only arrival before the first actual actionable clock can observe without an action witness.
export function observeStartupTurn(actor, previous, next) {
 assert.ok(['waiting','preflop','flop','turn','river','showdown'].includes(next.stage));
 assert.ok(Number.isSafeInteger(next.hand_number)&&next.hand_number>=0);
 const nonacting=next.current_player===null||!betting.has(next.stage);
 let inactive=false;
 if(!nonacting){
  const player=next.players.find(p=>p.user_id===next.current_player);assert.ok(player);
  assert.ok(Number.isFinite(player.stack)&&player.stack>=0&&typeof player.is_folded==='boolean'&&typeof player.is_all_in==='boolean');
  assert.ok(Number.isSafeInteger(next.turn_start_time_ms)&&next.turn_start_time_ms>0);
  inactive=player.stack===0||player.is_folded||player.is_all_in;
 }
 if(!previous&&(nonacting||inactive)){
  assert.ok(Number.isSafeInteger(next.turn_start_time_ms)&&next.turn_start_time_ms>=0);
  actor.awaitingActionableBaseline={hand:next.hand_number,clock:next.turn_start_time_ms};
 }
 const baseline=actor.awaitingActionableBaseline;if(!baseline)return false;
 assert.ok(next.hand_number>=baseline.hand,'Observer hand regressed');
 if(nonacting||inactive||(next.hand_number===baseline.hand&&next.turn_start_time_ms<=baseline.clock))return true;
 actor.awaitingActionableBaseline=null;return false;
}
