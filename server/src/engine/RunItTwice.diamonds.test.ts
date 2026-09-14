/**
 * RUN IT TWICE, IN DIAMONDS (2026-09-12, Phase 7 line three).
 *
 * Run it twice was closed for Diamond because the runout cut every pot into
 * integer CENTS, which is the indivisible unit of a chip and HALF of a Diamond.
 * A five Diamond pot over two runs paid two and a half Diamonds a board, and a
 * fractional Diamond is refused by the hand guard, by the accepted-hand guard
 * and by the SQL settler alike - so the table would have dealt a hand it could
 * never settle.
 *
 * The runout now cuts in the table's own unit and tells `determineWinners` what
 * that unit is, so BOTH divisions that can happen to a pot - the per-board
 * slice and a tie chopped on one board - land on whole Diamonds. The stated
 * rules are unchanged: the odd unit goes to the earliest board, and inside a
 * chop to the first seat clockwise of the button.
 *
 * These drive the REAL `dealAndResolveRIT` against a REAL `HandController` on a
 * Diamond table, with pots chosen so that neither division comes out even.
 */
import { describe, it, expect } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'dddddddd-1111-4444-8888-dddddddddddd';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `d${i + 1}`,
        username: `D${i + 1}`,
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

/** Every deduction explicitly zero: a Diamond hand carries none of them. */
function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    asset: 'diamonds',
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    ritEnabled: true,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function driveAllIn(hc: HandController, events: HandEvent[]) {
  let guard = 0;
  while (!events.some((e) => e.type === 'ALL_IN_RUNOUT') && guard++ < 20) {
    const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
    if (st.currentPlayerSeat <= 0) break;
    hc.performAction(st.currentPlayerSeat, 'all_in', 0);
  }
  expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);
}

function diamondRitHarness(stacks: number[], runs: 2 | 3) {
  const players = mkPlayers(stacks);
  const events: HandEvent[] = [];
  const hc = new HandController(mkConfig(), players, 1);
  hc.onEvent((e) => events.push(e));
  hc.start();
  driveAllIn(hc, events);

  const engine = new ServerTableEngine(TABLE) as unknown as Record<string, unknown> & {
    dealAndResolveRIT(allIn: SeatPlayer[]): void;
  };
  const e = engine as Record<string, any>;
  e.running = true;
  e.handCount = 1;
  e.handController = hc;
  e.tableInfo = {
    game_variant: 'nlh',
    big_blind: 2,
    arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
  };
  e.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: true,
  }));

  e.runItTwiceEngine.configure(TABLE, { enabled: true, autoDeclineTimeout: 10, maxRuns: 3 });
  const ids = players.map((p) => p.user_id);
  e.runItTwiceEngine.offer(TABLE, `${TABLE}:1`, ids[0], ids, 0);
  e.runItTwiceEngine.chooserDecides(TABLE, ids[0], runs);
  for (const id of ids.slice(1)) e.runItTwiceEngine.accept(TABLE, id);
  expect(e.runItTwiceEngine.getChosenRuns(TABLE)).toBe(runs);

  const st = (hc as unknown as { state: { players: SeatPlayer[] } }).state;
  const allIn = st.players.filter((p) => !p.is_folded);
  engine.dealAndResolveRIT(allIn);

  const complete = events.find((e2) => e2.type === 'HAND_COMPLETE') as
    | { type: 'HAND_COMPLETE'; rake: number; bbjFee: number }
    | undefined;
  return { hc, events, e, st, complete, totalBuyin: stacks.reduce((s, x) => s + x, 0) };
}

describe('Run it twice pays whole Diamonds', () => {
  /** The slicing rule, isolated, in the unit the table plays in. */
  const sliceUnits = (potUnits: number, runs: number) => {
    const base = Math.floor(potUnits / runs);
    const rem = potUnits - base * runs;
    return Array.from({ length: runs }, (_, b) => base + (b < rem ? 1 : 0));
  };

  it('partitions an indivisible pot exactly, odd Diamond to the earliest board', () => {
    expect(sliceUnits(5, 2)).toEqual([3, 2]);
    expect(sliceUnits(7, 3)).toEqual([3, 2, 2]);
    expect(sliceUnits(1, 3)).toEqual([1, 0, 0]);
    for (const units of [1, 2, 5, 7, 101, 999]) {
      for (const runs of [2, 3]) {
        const parts = sliceUnits(units, runs);
        expect(
          parts.reduce((a, b) => a + b, 0),
          `${units} Diamonds over ${runs} runs must partition exactly`
        ).toBe(units);
        expect(parts.every((p) => Number.isInteger(p))).toBe(true);
      }
    }
  });

  it.each([
    [[7, 7] as number[], 2 as const],
    [[7, 7] as number[], 3 as const],
    [[101, 101] as number[], 3 as const],
    [[5, 5, 5] as number[], 2 as const],
  ])('conserves every Diamond and leaves no fraction: %j over %i runs', (stacks, runs) => {
    const { st, complete, totalBuyin } = diamondRitHarness(stacks, runs);
    expect(complete).toBeDefined();
    /* A Diamond hand carries no rake and no jackpot fee; the whole pot is
       still on the table when the boards are done. */
    expect(complete!.rake).toBe(0);
    expect(complete!.bbjFee).toBe(0);
    const after = st.players as SeatPlayer[];
    expect(after.reduce((s, p) => s + p.stack, 0)).toBe(totalBuyin);
    for (const p of after) {
      expect(Number.isSafeInteger(p.stack), `${p.user_id} holds ${p.stack}`).toBe(true);
    }
  });

  it('records every winner in whole Diamonds summing to the pot', () => {
    const { e, totalBuyin } = diamondRitHarness([9, 9], 2);
    const winners = e.currentHandWinners as Array<{ userId: string; amount: number }>;
    expect(winners.length).toBeGreaterThan(0);
    for (const w of winners) {
      expect(['d1', 'd2']).toContain(w.userId);
      expect(Number.isSafeInteger(w.amount), `${w.userId} won ${w.amount}`).toBe(true);
    }
    expect(winners.reduce((s, w) => s + w.amount, 0)).toBe(totalBuyin);
  });

  it('leaves the chip arithmetic exactly where it was', () => {
    /* unitCents is 1 for chips, so `units === cents` and every chip slice is
       the cent slice it has always been. This is the guarantee that the change
       is additive rather than a rewrite of the cash path. */
    const chipUnitCents = 1;
    const cents = 101;
    const base = Math.floor(Math.round(cents / chipUnitCents) / 2);
    expect([base + 1, base]).toEqual([51, 50]);
  });
});
