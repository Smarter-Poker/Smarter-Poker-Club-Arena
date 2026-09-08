import { randomUUID } from 'node:crypto';
import type { HandController } from './HandController.js';

// Weak ownership avoids retaining completed hands. Incarnation identity also
// rejects a request after recovery rebuilds the same numbered hand.
const incarnations = new WeakMap<HandController, string>();
export function playerActionContext(hand: HandController): string | null {
  const state = hand.getState();
  // Runout, showdown and waiting snapshots have no betting decision to echo.
  if (state.currentPlayerSeat < 1 || !['preflop', 'flop', 'turn', 'river'].includes(state.stage))
    return null;
  let incarnation = incarnations.get(hand);
  if (!incarnation) {
    incarnation = randomUUID();
    incarnations.set(hand, incarnation);
  }
  // These are public action coordinates, never cards or deck state. The clock
  // is deliberately absent: buying time or reconnecting does not create a turn.
  return [
    incarnation,
    state.stage,
    state.actionHistory.length,
    state.currentPlayerSeat,
    state.currentBet,
  ].join(':');
}
