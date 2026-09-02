/**
 * A Crazy Pineapple showdown is TWO hole cards. On EVERY runout path.
 *
 * There are two ways an all-in hand runs out:
 *   - runOutCommunityCards() — the instant runout
 *   - dealNextStreet()       — the per-street path, taken whenever the table
 *                              has insurance or run-it-twice enabled
 *
 * AUDIT V2 (2026-07-23) fixed the first. Its comment names the failure exactly:
 * the discard phase is skipped when everyone is already all-in, so without an
 * explicit resolve "players still held THREE hole cards at showdown and
 * evaluateHand scored best-5-of-8, an illegal extra-card advantage."
 *
 * The second never got the line — and all three live pineapple tables have
 * insurance and/or RIT switched on, so it kept happening and kept paying.
 *
 * Production hand #3831745 (table 0be5fa47, 2026-08-31 07:21 UTC),
 * board 2h 3c 5d Qc 4h:
 *
 *     seat A   Jh Ah Kh   -> awarded "Flush",    22.57 of a 34.00 pot
 *     seat B   Ad Kc 5h   -> "Straight",          7.53
 *
 * The board holds exactly TWO hearts. No legal two-card hold makes a flush
 * there — it needed all three of its own cards. The straight was the best
 * legal hand and should have scooped. Three more hands in the same twelve
 * hours reached showdown with three cards.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function mkPlayers(n: number, stack = 200): SeatPlayer[] {
  return Array.from(
    { length: n },
    (_, i) =>
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

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 'pineapple-runout',
    handNumber: 1,
    gameVariant: 'pineapple',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

/** A fresh pineapple hand, dealt, before any street.
 *
 * 2026-08-31: dealNextStreet is the all-in per-street runout path and now
 * refuses a hand where betting is still live (the stale-runout guard that
 * closed the rake-law alarm's no_flop_no_drop findings). These tests drive
 * the path directly, so put the hand in the state the path actually runs in:
 * everyone all-in. */
function dealt() {
  const hc = new HandController(mkConfig(), mkPlayers(3), 1);
  hc.start();
  const st = () => (hc as unknown as { state: any }).state;
  for (const p of st().players) p.is_all_in = true;
  return { hc, st };
}

const holdings = (st: () => any): number[] =>
  st()
    .players.filter((p: SeatPlayer) => !p.is_folded)
    .map((p: SeatPlayer) => p.cards.length);

describe('pineapple: nobody reaches showdown holding three cards', () => {
  it('deals three to start (otherwise the rest of this file proves nothing)', () => {
    const { st } = dealt();
    expect(holdings(st)).toEqual([3, 3, 3]);
  });

  it('the PER-STREET runout resolves the discard as the flop lands', () => {
    const { hc, st } = dealt();

    // No discard STAGE is opened here on purpose: this is the all-in case,
    // where betting never reaches the discard round. The resolve has to happen
    // on the deal itself, which is the bug.
    const r = hc.dealNextStreet();

    expect(r.stage).toBe('flop');
    expect(r.board.length).toBe(3);
    expect(
      holdings(st),
      'a seat still holding 3 after the flop is the best-5-of-8 bug that paid ' +
        'an impossible flush in production hand #3831745'
    ).toEqual([2, 2, 2]);
  });

  it('stays at two through the turn and the river', () => {
    const { hc, st } = dealt();
    hc.dealNextStreet(); // flop
    expect(holdings(st)).toEqual([2, 2, 2]);
    hc.dealNextStreet(); // turn
    const river = hc.dealNextStreet();
    expect(river.complete).toBe(true);
    expect(holdings(st)).toEqual([2, 2, 2]);
  });

  it('leaves every card accounted for - one discard per seat, no duplicates', () => {
    const { hc, st } = dealt();
    hc.dealNextStreet();
    const all = st()
      .players.flatMap((p: SeatPlayer) => p.cards)
      .concat(st().communityCards)
      .map((c: { rank: string; suit: string }) => `${c.rank}${c.suit}`);
    expect(new Set(all).size, 'a duplicated card means the resolve spliced wrong').toBe(all.length);
  });

  it('a NON-pineapple variant is untouched by the resolve', () => {
    const hc = new HandController(mkConfig({ gameVariant: 'nlh' }), mkPlayers(3), 1);
    hc.start();
    const st = () => (hc as unknown as { state: any }).state;
    for (const p of st().players) p.is_all_in = true; // runout guard: see dealt()
    hc.dealNextStreet();
    expect(holdings(st)).toEqual([2, 2, 2]);
  });
});
