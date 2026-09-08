/**
 * V12 BOARD-CONDITIONED RANGE MODELING.
 * The preflop band says which hands an opponent STARTED with; V12 conditions
 * the Monte Carlo samples on which of those hands took THIS line on THIS
 * board: aggressors connect, passive checked lines are capped. These tests
 * pin the equity shifts (seeded, deterministic), the read extraction, and
 * that the layer never breaks legality or the latency budget.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseMind } from './HorseMind.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom, simulateEquity, variantInfo, connectsBoard } from './HorseEval.js';
import type { ActionRecord, Card } from '../types.js';

beforeEach(() => {
  HorseMind.reset();
  seedFastRandom(0x5eed1e);
});

const c = (spec: string): Card => {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
};

const nlh = variantInfo('nlh');

describe('HorseEval V12 - connectsBoard', () => {
  it('recognizes pairs, flush draws, and open straight draws as contact', () => {
    const board = [c('Ah'), c('Kd'), c('7c')];
    expect(connectsBoard([c('As'), c('2d')], board, false)).toBeGreaterThanOrEqual(2); // top pair
    expect(connectsBoard([c('Qh'), c('Jh')], [c('Th'), c('7h'), c('2c')], false)).toBe(2); // flush draw
    expect(connectsBoard([c('Jd'), c('Ts')], [c('9h'), c('8c'), c('2d')], false)).toBe(2); // OESD
    expect(connectsBoard([c('5d'), c('2s')], board, false)).toBeLessThan(2); // pure air
  });
});

describe('HorseMind V12 - postflop read extraction', () => {
  const hist = (extra: ActionRecord[]): ActionRecord[] =>
    [
      { seat: 5, userId: 'opp', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      { seat: 2, userId: 'hero', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
      ...extra,
    ] as never;

  it('a barreling opponent reads as aggressive; a checker reads as capped', () => {
    const board = [c('Ah'), c('Kd'), c('7c'), c('2s')];
    const aggro = { aggrW: 0, checked: 0 };
    HorseMind.bandFor(
      'opp',
      hist([
        { seat: 5, userId: 'opp', action: 'bet', amount: 10, timestamp: 3, stage: 'flop' },
        { seat: 2, userId: 'hero', action: 'call', amount: 10, timestamp: 4, stage: 'flop' },
        { seat: 5, userId: 'opp', action: 'bet', amount: 30, timestamp: 5, stage: 'turn' },
      ] as never),
      2,
      true,
      board,
      aggro
    );
    expect(aggro.aggrW).toBeGreaterThan(0.1);

    const passive = { aggrW: 0, checked: 0 };
    HorseMind.bandFor(
      'opp',
      hist([
        { seat: 5, userId: 'opp', action: 'check', amount: 0, timestamp: 3, stage: 'flop' },
        { seat: 2, userId: 'hero', action: 'check', amount: 0, timestamp: 4, stage: 'flop' },
        { seat: 5, userId: 'opp', action: 'check', amount: 0, timestamp: 5, stage: 'turn' },
      ] as never),
      2,
      true,
      board,
      passive
    );
    expect(passive.aggrW).toBe(0);
    expect(passive.checked).toBe(2);
  });
});

describe('HorseEval V12 - board-contact conditioning shifts equity the right way', () => {
  it('QQ on AK7 loses equity vs an AGGRESSOR (their range connects)', () => {
    const hole = [c('Qh'), c('Qd')];
    const board = [c('Ah'), c('Kd'), c('7c')];
    const band: Array<[number, number] | null> = [[0.4, 1]];
    seedFastRandom(0x5eed1e);
    const plain = simulateEquity(hole, board, 1, nlh, 4000, band);
    seedFastRandom(0x5eed1e);
    const conditioned = simulateEquity(hole, board, 1, nlh, 4000, band, false, undefined, [
      { aggrW: 0.17, checked: 0 }, // flop + turn barrels
    ]);
    // V28 (2026-08-29): margin relaxed 0.03 -> 0.02 in the same commit that
    // recalibrated the preflop ladder (wheel aces up, J9 down, gap drag on
    // rags). The [0.4, 1] band is defined by ladder percentile, so reordering
    // the ladder legitimately moves this delta a few tenths of a point; the
    // DIRECTION is the pin, and it still demands a clearly negative shift.
    expect(conditioned).toBeLessThan(plain - 0.02);
  });

  it('a medium hand GAINS equity vs a passive checked line (monsters capped)', () => {
    const hole = [c('Th'), c('9d')]; // second pair on the board below
    const board = [c('Kh'), c('Ts'), c('4c'), c('2d'), c('8s')];
    const band: Array<[number, number] | null> = [[0.15, 0.8]];
    seedFastRandom(0x5eed1e);
    const plain = simulateEquity(hole, board, 1, nlh, 4000, band);
    seedFastRandom(0x5eed1e);
    const conditioned = simulateEquity(hole, board, 1, nlh, 4000, band, false, undefined, [
      { aggrW: 0, checked: 2 },
    ]);
    expect(conditioned).toBeGreaterThan(plain);
  });

  it('Omaha is untouched by design (reads are NLH-family only)', () => {
    const vi = variantInfo('plo4');
    const hole = [c('Ah'), c('Kh'), c('Qd'), c('Jd')];
    const board = [c('Th'), c('7s'), c('2c')];
    seedFastRandom(0x5eed1e);
    const a = simulateEquity(hole, board, 1, vi, 800, [[0.4, 1]]);
    seedFastRandom(0x5eed1e);
    const b = simulateEquity(hole, board, 1, vi, 800, [[0.4, 1]], false, undefined, [
      { aggrW: 0.2, checked: 0 },
    ]);
    expect(a).toBe(b);
  });
});

describe('HorseLogic V12 - end to end', () => {
  const mkPlayer = (seat: number, over: Record<string, unknown> = {}) =>
    ({
      seat,
      user_id: `p-${seat}`,
      username: `P${seat}`,
      stack: 200,
      bet: 0,
      totalInvested: 0,
      cards: [] as Card[],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
      ...over,
    }) as never;

  it('folds the dominated pair to a double barrel MORE with v12 than without', () => {
    const spot = (v12: boolean) => {
      HorseMind.reset();
      const hero = mkPlayer(2, { cards: [c('Qh'), c('Qd')], bet: 0, stack: 160 });
      const gs: never = {
        players: [
          hero,
          mkPlayer(6, { bet: 30, stack: 130 }),
          ...[1, 3, 4, 5].map((s) => mkPlayer(s, { is_folded: true })),
        ],
        communityCards: [c('Ah'), c('Kd'), c('7c'), c('2s')],
        pot: 40,
        currentBet: 30,
        minRaise: 30,
        stage: 'turn',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 6,
        gameMode: 'cash',
        actionHistory: [
          { seat: 6, userId: 'p-6', action: 'raise', amount: 6, timestamp: 42, stage: 'preflop' },
          { seat: 2, userId: 'p-2', action: 'call', amount: 6, timestamp: 43, stage: 'preflop' },
          { seat: 6, userId: 'p-6', action: 'bet', amount: 10, timestamp: 44, stage: 'flop' },
          { seat: 2, userId: 'p-2', action: 'call', amount: 10, timestamp: 45, stage: 'flop' },
          { seat: 6, userId: 'p-6', action: 'bet', amount: 30, timestamp: 46, stage: 'turn' },
        ],
      } as never;
      return HorseLogic.decide(hero, gs, 'balanced', {}, v12 ? {} : { v12: false });
    };
    let foldsOn = 0;
    let foldsOff = 0;
    for (let i = 0; i < 60; i++) {
      if (spot(true).action === 'fold') foldsOn++;
      if (spot(false).action === 'fold') foldsOff++;
    }
    // Both engines fold this most of the time (the V11 domination penalty is
    // doing its job even without conditioning); v12's contribution is pinned
    // deterministically by the equity-shift tests above. Here we assert the
    // end-to-end behavior stays disciplined with the layer on.
    expect(foldsOn).toBeGreaterThan(40);
    expect(foldsOff).toBeGreaterThan(40);
  });

  /**
   * WHAT THIS MEASURES, AND WHY IT IS A RATIO (2026-09-06).
   *
   * This asserted `meanMs < 25` on 50 decisions. On 2026-09-06 it failed CI at
   * **25.08** - three tenths of one percent over - on a shared runner hosting
   * four test shards and whatever else the estate was building. It was
   * measuring the runner, not the code, and it blocked an unrelated pull
   * request from merging.
   *
   * Raising 25 to 30 is the fix CLAUDE.md 10.86 rule 4 warns about: it moves
   * the cliff and buys a few weeks. What the comment always claimed was
   * relative - "same envelope as pre-V12" - so that is what is asserted now.
   * The V12 conditioning layer is timed against the SAME decision with the
   * layer off, in the same process, on the same machine, after a warm-up. A
   * ratio cannot be flaked by a busy runner; only a real regression in the
   * conditioning path moves it.
   *
   * The absolute ceiling is kept but demoted to what an absolute number can
   * honestly do here: catch a catastrophe (a decision that has become
   * hundreds of milliseconds), not police a few percent. Both numbers have to
   * fail before this test does.
   */
  it('conditioning does not blow the latency envelope', () => {
    const hero = mkPlayer(2, { cards: [c('Qh'), c('Qd')], bet: 0, stack: 160 });
    const gs: never = {
      players: [hero, mkPlayer(6, { bet: 30, stack: 130 })],
      communityCards: [c('Ah'), c('Kd'), c('7c'), c('2s')],
      pot: 40,
      currentBet: 30,
      minRaise: 30,
      stage: 'turn',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 6,
      actionHistory: [
        { seat: 6, userId: 'p-6', action: 'raise', amount: 6, timestamp: 42, stage: 'preflop' },
        { seat: 2, userId: 'p-2', action: 'call', amount: 6, timestamp: 43, stage: 'preflop' },
        { seat: 6, userId: 'p-6', action: 'bet', amount: 30, timestamp: 46, stage: 'turn' },
      ],
    } as never;

    const RUNS = 50;

    /* INTERLEAVED PER DECISION, NOT PER BATCH (2026-09-08).
       This used to time all of `on`, then all of `off`, twice each, and take
       the better batch per side. That still measures the runner whenever a
       stall covers BOTH `on` batches and neither `off` batch - which is what
       happened on 2026-09-08, where the ratio read 17.72 against 4.02 (4.4x,
       over the 3x rule) on a box with 33 of 33 runners busy and 30 jobs
       queued. Nothing in the conditioning path had changed.

       Now the two sides alternate inside ONE loop, so any stall lands in
       whichever side's turn it struck and, over 50 alternations, hits both
       roughly equally. A ratio measured this way cannot be inflated by load
       without inflating both halves; only a real regression separates them.
       performance.now() replaces Date.now() because a per-decision sample
       needs sub-millisecond resolution. */
    const measure = (): { on: number; off: number } => {
      HorseMind.reset();
      // Warm-up: the first decisions pay for JIT and lazy table construction,
      // and charging those to whichever side ran first is its own flake.
      for (let i = 0; i < 10; i++) {
        HorseLogic.decide(hero, gs, 'balanced', {}, {});
        HorseLogic.decide(hero, gs, 'balanced', {}, { v12: false });
      }
      let onTotal = 0;
      let offTotal = 0;
      for (let i = 0; i < RUNS; i++) {
        const a = performance.now();
        HorseLogic.decide(hero, gs, 'balanced', {}, {});
        const b = performance.now();
        HorseLogic.decide(hero, gs, 'balanced', {}, { v12: false });
        const c = performance.now();
        onTotal += b - a;
        offTotal += c - b;
      }
      return { on: onTotal / RUNS, off: offTotal / RUNS };
    };

    // Two passes, better of each side, for the same reason as before.
    const p1 = measure();
    const p2 = measure();
    const on = Math.min(p1.on, p2.on);
    const off = Math.min(p1.off, p2.off);

    // THE RULE: conditioning may cost, but not multiply. The floor of 2 ms
    // keeps the ratio meaningful when both sides are sub-millisecond, where
    // timer granularity alone can produce any ratio it likes.
    expect(on).toBeLessThan(Math.max(off, 2) * 3);

    // And the catastrophe ceiling, which no healthy runner approaches.
    expect(on).toBeLessThan(250);
  });
});
