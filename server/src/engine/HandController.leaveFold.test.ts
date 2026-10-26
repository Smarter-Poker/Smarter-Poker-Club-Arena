/** Leaving may queue a fold, but no controller door may execute it off turn. */
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

describe('a leaver folds only on their turn on a cash table', () => {
  it('refuses the early action without changing cards, history, chips or the current actor', () => {
    const { hc, events, st, total } = start(6);
    const before = total();
    const actor = st().currentPlayerSeat;
    const leaver = st().players.find(
      (p: SeatPlayer) => p.seat !== actor && !p.is_folded && !p.is_all_in
    ).seat;

    const stateBefore = structuredClone(st());
    const eventsBefore = events.length;
    expect(hc.performImmediateFold(leaver, 'forced')).toBe(false);
    expect(st()).toEqual(stateBefore);
    expect(events.length).toBe(eventsBefore);
    expect(st().players.find((p: SeatPlayer) => p.seat === leaver).is_folded).toBe(false);
    expect(st().currentPlayerSeat).toBe(actor);
    expect(
      events.some(
        (e: any) => e.type === 'PLAYER_ACTION' && e.seat === leaver && e.action === 'fold'
      )
    ).toBe(false);
    expect(total()).toBe(before);
  });

  it('the queued leaver can fold once the actor finishes; the hand then conserves every chip', () => {
    const { hc, events, st, total } = start(2);
    const before = total();
    const actor = st().currentPlayerSeat;
    const leaver = actor === 1 ? 2 : 1;

    expect(hc.performImmediateFold(leaver, 'forced')).toBe(false);
    expect(hc.performAction(actor, 'call')).toBe(true);
    expect(st().currentPlayerSeat).toBe(leaver);
    expect(hc.performImmediateFold(leaver, 'forced')).toBe(true);
    expect(events.some((e: any) => e.type === 'HAND_COMPLETE')).toBe(true);
    // Settled: every chip is back on a stack, none created or lost.
    expect(st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0)).toBe(before);
  });
});
