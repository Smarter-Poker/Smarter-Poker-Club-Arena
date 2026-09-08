import { randomUUID } from 'node:crypto';
import type { HandController } from './HandController.js';

// Weak ownership avoids retaining completed hands. Incarnation identity also
// rejects a request after recovery rebuilds the same numbered hand.
const incarnations = new WeakMap<HandController, string>();
export function playerActionContext(hand: HandController): string {
  let incarnation = incarnations.get(hand);
  if (!incarnation) {
    incarnation = randomUUID();
    incarnations.set(hand, incarnation);
  }
  const state = hand.getState();
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
