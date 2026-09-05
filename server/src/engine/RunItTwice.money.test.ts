/**
 * RUN IT TWICE — money-path proof (2026-08-18, Dan's directive: users must
 * be able to run it two or three times with pots split correctly and rake +
 * BBJ taken out).
 *
 * Drives the REAL ServerTableEngine.dealAndResolveRIT against a REAL
 * HandController at the exact all-in runout point. Asserts, for 2 and 3
 * runs and for side pots:
 *   - chip conservation: stacks + rake + bbjFee === chips that sat down
 *   - rake and the BBJ fee are deducted exactly ONCE (not per board)
 *   - the winners record is populated (E1) and sums to the net pot
 *   - every chip recipient was an all-in participant
 *
 * Also pins the RAKE LEAK FIX: a preflop all-in runout deals the flop, so
 * "no flop no drop" must NOT zero the rake/BBJ - single-run and RIT alike.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 5, minPlayersDealt: 2 },
    ...over,
  } as HandConfig;
}

/** Shove seats in turn order until the hand parks at the all-in runout. */
function driveAllIn(hc: HandController, events: HandEvent[]) {
  let guard = 0;
  while (!events.some((e) => e.type === 'ALL_IN_RUNOUT') && guard++ < 20) {
    const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
    if (st.currentPlayerSeat <= 0) break;
    hc.performAction(st.currentPlayerSeat, 'all_in', 0);
  }
  expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);
}

function ritHarness(stacks: number[], runs: 2 | 3) {
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
  e.tableInfo = { game_variant: 'nlh', big_blind: 10 };
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

/**
 * THE ODD CENT HAS A RULE NOW (2026-09-05).
 *
 * Each board used to be evaluated against the FULL pots and the winner's
 * entitlement then divided by `runs` in floating point. Nothing was lost —
 * the repairs downstream saw to that — but which run carried the odd cent was
 * whatever the rounding happened to do, and a pot that does not divide by
 * three cannot be explained to a player by "whatever the rounding did".
 *
 * Every pot is now cut into `runs` integer-cent slices up front, leftover
 * cents to the EARLIEST runs, and each board settles its own slice through
 * the ordinary path. These pin the two things that follow: the slices are a
 * partition of the pot (nothing invented, nothing destroyed), and the rule is
 * stated in the code rather than emergent from arithmetic.
 */
describe('RIT per-run split - integer cents, odd cent to the earliest run', () => {
  /** The slicing rule, isolated. Mirrors dealAndResolveRIT exactly. */
  const sliceCents = (potCents: number, runs: number) => {
    const base = Math.floor(potCents / runs);
    const rem = potCents - base * runs;
    return Array.from({ length: runs }, (_, b) => base + (b < rem ? 1 : 0));
  };

  it('a pot that does not divide by three still sums to the pot, exactly', () => {
    // 10.00 over three runs: 334/333/333 in cents. The old float world gave
    // 3.3333... three times, which is 9.9999... and not a pot.
    for (const cents of [1000, 1, 2, 5, 999, 2227, 881]) {
      for (const runs of [2, 3]) {
        const parts = sliceCents(cents, runs);
        expect(
          parts.reduce((a, b) => a + b, 0),
          `${cents}c over ${runs} runs must partition exactly`
        ).toBe(cents);
        expect(parts.every((p) => Number.isInteger(p))).toBe(true);
      }
    }
  });

  it('gives the odd cents to the earliest runs, in order', () => {
    expect(sliceCents(1000, 3)).toEqual([334, 333, 333]);
    expect(sliceCents(1001, 3)).toEqual([334, 334, 333]);
    expect(sliceCents(1002, 3)).toEqual([334, 334, 334]);
    expect(sliceCents(101, 2)).toEqual([51, 50]);
    // A pot too small to reach every board still pays the first ones rather
    // than paying nobody: 1 cent over 3 runs is 1/0/0, not 0/0/0.
    expect(sliceCents(1, 3)).toEqual([1, 0, 0]);
    expect(sliceCents(2, 3)).toEqual([1, 1, 0]);
  });

  it('the engine divides nothing by runs any more', () => {
    /**
     * A source law. The runtime conservation tests below pass just as well
     * with `w.amount / runs` restored, because the downstream repairs hide
     * it — which is exactly why the float divide survived so long. The point
     * of the change is that the division happens ONCE, in cents, with a rule.
     */
    const src = readFileSync(join(__dirname, 'ServerTableEngineRunout.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'no per-winner division by runs').not.toMatch(/amount\s*\/\s*runs/);
    expect(code, 'the pots are sliced once, up front').toMatch(/potSlicesByBoard/);
  });

  it('three runs over a real hand still conserve every chip', () => {
    // The rule change is upstream of rake, so the end-to-end invariant is the
    // one that proves it did not leak: chips in === stacks + rake + bbj.
    const { st, complete, totalBuyin } = ritHarness([333, 333, 333], 3);
    const stacks = (st.players as SeatPlayer[]).reduce((s, p) => s + p.stack, 0);
    const rake = complete?.rake ?? 0;
    const bbj = complete?.bbjFee ?? 0;
    expect(Math.round((stacks + rake + bbj) * 100) / 100).toBe(totalBuyin);
  });
});

describe('RIT money path - 2 runs, heads-up', () => {
  it('conserves chips, takes rake + BBJ once, and records winners summing to the net pot', () => {
    const { e, st, complete, totalBuyin } = ritHarness([500, 500], 2);

    expect(complete).toBeDefined();
    // Preflop all-in, full boards dealt → rake and BBJ fee MUST apply
    // (the rake-leak fix): 5% of 1000 capped at 100 → 50; fee 0.25 BB → 2.5.
    expect(complete!.rake).toBe(50);
    expect(complete!.bbjFee).toBe(2.5);

    const stacksAfter = st.players.reduce((s, p) => s + p.stack, 0);
    expect(stacksAfter + complete!.rake + complete!.bbjFee).toBe(totalBuyin);

    const winners = e.currentHandWinners as Array<{ userId: string; amount: number }>;
    expect(winners.length).toBeGreaterThan(0); // E1: record is not blank
    const paid = winners.reduce((s, w) => s + w.amount, 0);
    expect(paid).toBeCloseTo(totalBuyin - complete!.rake - complete!.bbjFee, 2);
    for (const w of winners) {
      expect(['u1', 'u2']).toContain(w.userId);
      expect(w.amount).toBeGreaterThan(0);
    }
    // Board-0 winner leads the id list (BBJ reads index 0).
    expect((e.currentHandWinnerIds as string[]).length).toBeGreaterThan(0);

    // HAND HISTORY: board 0 recorded as the hand's community cards, and the
    // second runout appended to the action log (was: no board at all).
    expect((e.currentHandCommunityCards as string[]).length).toBe(5);
    const ritActions = (e.currentHandActions as Array<{ action: string }>).filter((a) =>
      a.action.startsWith('rit_board_')
    );
    expect(ritActions.length).toBe(1); // runs=2 → one extra board
    // Card format matches the engine's rank+suit strings (e.g. 'Ahearts').
    expect(ritActions[0].action).toMatch(
      /^rit_board_2:([2-9TJQKA10]{1,2}(hearts|diamonds|clubs|spades),){4}[2-9TJQKA10]{1,2}(hearts|diamonds|clubs|spades)$/
    );
  });
});

describe('RIT money path - 3 runs, heads-up', () => {
  it('splits across three boards with the same conservation and single rake/BBJ', () => {
    const { st, complete, e, totalBuyin } = ritHarness([500, 500], 3);

    expect(complete!.rake).toBe(50); // once — NOT 3x
    expect(complete!.bbjFee).toBe(2.5); // once — NOT 3x
    const stacksAfter = st.players.reduce((s, p) => s + p.stack, 0);
    expect(stacksAfter + complete!.rake + complete!.bbjFee).toBe(totalBuyin);

    const winners = e.currentHandWinners as Array<{ userId: string; amount: number }>;
    const paid = winners.reduce((s, w) => s + w.amount, 0);
    expect(paid).toBeCloseTo(totalBuyin - 52.5, 2);

    // runs=3 → boards 2 and 3 appended to the action log.
    const ritActions = (e.currentHandActions as Array<{ action: string }>).filter((a) =>
      a.action.startsWith('rit_board_')
    );
    expect(ritActions.length).toBe(2);
  });
});

describe('RIT money path - 3-way with side pot', () => {
  it('conserves chips across main + side pots with uncalled excess returned', () => {
    // 100 / 300 / 500: short stack caps the main pot; u3's excess over u2's
    // 300 is uncalled and returned before rake.
    const { st, complete, e, totalBuyin } = ritHarness([100, 300, 500], 2);

    expect(complete).toBeDefined();
    expect(complete!.rake).toBeGreaterThan(0);
    const stacksAfter = st.players.reduce((s, p) => s + p.stack, 0);
    expect(stacksAfter + complete!.rake + complete!.bbjFee).toBe(totalBuyin);

    const winners = e.currentHandWinners as Array<{ userId: string; amount: number }>;
    expect(winners.length).toBeGreaterThan(0);
    for (const w of winners) {
      expect(['u1', 'u2', 'u3']).toContain(w.userId);
    }
  });
});

describe('RAKE LEAK FIX - single-run preflop all-in runout', () => {
  it('collects rake and the BBJ fee when the runout deals the flop (noFlopNoDrop)', () => {
    const players = mkPlayers([500, 500]);
    const events: HandEvent[] = [];
    const hc = new HandController(mkConfig(), players, 1);
    hc.onEvent((e2) => events.push(e2));
    hc.start();
    driveAllIn(hc, events);

    hc.continueRunout(); // deals the full board — the flop IS seen
    const complete = events.find((e2) => e2.type === 'HAND_COMPLETE') as
      | { type: 'HAND_COMPLETE'; rake: number; bbjFee: number }
      | undefined;
    expect(complete).toBeDefined();
    // Before the fix these were BOTH 0 on every preflop all-in hand.
    expect(complete!.rake).toBe(50);
    expect(complete!.bbjFee).toBe(2.5);

    const st = (hc as unknown as { state: { players: SeatPlayer[] } }).state;
    const stacksAfter = st.players.reduce((s, p) => s + p.stack, 0);
    expect(stacksAfter + complete!.rake + complete!.bbjFee).toBe(1000);
  });
});
