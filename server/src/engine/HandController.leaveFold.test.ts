/**
 * The out-of-turn fold a leaving player gets (Dan 2026-10-25, "LEAVE NOW, EVEN
 * IF ITS IN THE MIDDLE OF A HAND"), driven through the REAL HandController on
 * an ordinary cash configuration (not Lightning). ServerTableEngine.leaveTable
 * uses performImmediateFold for a leaver whose turn it is not; this pins that
 * the fold lands at once, is recorded and announced as a real FOLD, leaves the
 * player on the clock exactly where they were, and conserves every chip.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const players = (n: number): SeatPlayer[] =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack: 200,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );

const config = {
  tableId: 't-leave',
  handNumber: 1,
  gameVariant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
} as HandConfig;

function start(n: number) {
  const hc = new HandController(config, players(n), 1);
  const events: HandEvent[] = [];
  hc.onEvent((e) => events.push(e));
  hc.start();
  const st = () => (hc as unknown as { state: any }).state;
  const total = () => st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0) + st().pot;
  return { hc, events, st, total };
}

describe('a leaver folds out of turn at once on a cash table', () => {
  it('folds now, records a FOLD, and leaves the acting player on their own clock', () => {
    const { hc, events, st, total } = start(6);
    const before = total();
    const actor = st().currentPlayerSeat;
    const leaver = st().players.find(
      (p: SeatPlayer) => p.seat !== actor && !p.is_folded && !p.is_all_in
    ).seat;

    expect(hc.performImmediateFold(leaver, 'forced')).toBe(true);

    expect(st().players.find((p: SeatPlayer) => p.seat === leaver).is_folded).toBe(true);
    expect(st().currentPlayerSeat).toBe(actor);
    expect(
      events.some(
        (e: any) => e.type === 'PLAYER_ACTION' && e.seat === leaver && e.action === 'fold'
      )
    ).toBe(true);
    expect(total()).toBe(before);
  });

  it('when the fold leaves one player, the hand completes and the chips are conserved', () => {
    const { hc, events, st, total } = start(2);
    const before = total();
    const actor = st().currentPlayerSeat;
    const leaver = actor === 1 ? 2 : 1;

    expect(hc.performImmediateFold(leaver, 'forced')).toBe(true);
    expect(events.some((e: any) => e.type === 'HAND_COMPLETE')).toBe(true);
    // Settled: every chip is back on a stack, none created or lost.
    expect(st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0)).toBe(before);
  });
});
