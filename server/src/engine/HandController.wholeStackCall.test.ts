/**
 * A WHOLE-STACK CALL IS ALL-IN, WHATEVER THE FLOAT SAYS (2026-10-08).
 *
 * Found by the WIN-POP human-calibrated league: a seat called exactly its
 * remaining stack, toCall was priced from two cent values (180.88 - 41.77 =
 * 139.10999999999999) against a stack of 139.11, the call left a 1e-14
 * residue, `stack === 0` missed it, and snapChips() then rounded the stack to
 * 0. The seat had no chips and no all-in flag, so on the next street the
 * controller named it the player to act while canAct was false, and the hand
 * stalled. performAction now decides the flag on the snapped stack.
 */
import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

const config = {
  tableId: 't-whole-stack-call',
  handNumber: 1,
  gameVariant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
} as HandConfig;

describe('a call for the whole stack flags the seat all-in', () => {
  it('flags the caller all-in when toCall carries a float residue below the stack', () => {
    expect(180.88 - 41.77).not.toBe(139.11); // the residue this test depends on
    const events: HandEvent[] = [];
    const hc = new HandController(config, mkPlayers([180.88, 180.88, 50]), 1);
    hc.onEvent((e) => events.push(e));
    hc.start();
    const s0 = hc.getState();
    expect(s0.currentPlayerSeat).toBe(1);
    expect(hc.performAction(1, 'raise', 41.77)).toBe(true);
    expect(hc.performAction(2, 'all_in')).toBe(true);
    expect(hc.performAction(3, 'fold')).toBe(true);
    expect(hc.performAction(1, 'call')).toBe(true);
    const caller = hc.getState().players.find((p) => p.seat === 1)!;
    expect(caller.stack).toBe(0);
    expect(caller.is_all_in).toBe(true);
    // Nobody with chips is left to act: the hand runs out instead of asking
    // a seat with nothing behind to act.
    for (let i = 0; i < 8 && !events.some((e) => e.type === 'HAND_COMPLETE'); i++) {
      const st = hc.getState();
      const actor = st.players.find((p) => p.seat === st.currentPlayerSeat);
      expect(actor ? actor.stack > 0 && !actor.is_all_in && !actor.is_folded : true).toBe(true);
      if (events.some((e) => e.type === 'ALL_IN_RUNOUT')) hc.continueRunout();
    }
    expect(events.some((e) => e.type === 'HAND_COMPLETE')).toBe(true);
    const end = hc.getState();
    expect(end.players.reduce((n, p) => n + p.stack, 0)).toBeCloseTo(180.88 * 2 + 50, 8);
  });
});
