/**
 * V15 OMAHA NUT DISCIPLINE (Dan 2026-08-26)
 *
 * Reproduces the exact hands Dan watched before the fix:
 *  - a horse CHECK-SHOVING a small flush instead of check-calling;
 *  - a horse calling off 800 chips with a NINE-HIGH flush in plo6, raised on
 *    a three-flush board, where the raiser always has a bigger flush;
 *  - plo5/plo6 playing way too many hands because the preflop score divisor
 *    ignored the hole count.
 *
 * Decisions are stochastic, so every scenario is run across many seeds and
 * asserted as an INVARIANT (never shove) or a FREQUENCY (folds dominate).
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom, omahaPreflopScore, omahaNutStatus } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

// RUNNER-CLASS TIMEOUT. Same defect as the HorseLogic fuzz bound above it in
// spirit, and the one that actually went red in HorseLeagueSandbox on
// 2026-09-02: these are compute-bound simulations measured against the 10s
// global in vitest.config.ts, and the estate moved CI to self-hosted runners
// (estate-ci-1, 4 vCPU, up to 8 concurrent jobs) where the same code runs at
// roughly 2x wall clock.
//
// This file had NO explicit bound anywhere, and on the 2026-09-02 self-hosted
// run "plo6 6-max 100bb" measured 10041ms against that 10000ms ceiling. It
// passed, but only just - it is the closest test in the server suite to going
// red for a reason that says nothing about the code. Its neighbours measured
// 7988ms, 7097ms, 6770ms and 5589ms.
//
// Only the WALL CLOCK moves, and only on the slow runner class. No assertion,
// hand count or trial count is touched: shrinking the simulations would make
// them cheaper by making them prove less, which is the opposite of the point.
// A genuine hang still trips the ceiling on every hardware class.
const SUITE_TIMEOUT_MS = 10_000 * (process.env.RUNNER_ENVIRONMENT === 'self-hosted' ? 3 : 1);

const h = 'hearts';
const d = 'diamonds';
const s = 'spades';
const cl = 'clubs';

function mkPlayer(over: Partial<SeatPlayer> & { cards: Card[] }): SeatPlayer {
  return {
    seat: 1,
    user_id: 'hero',
    username: 'hero',
    stack: 800,
    bet: 0,
    totalInvested: 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...over,
  } as SeatPlayer;
}

function opp(seat: number, over: Partial<SeatPlayer> = {}): SeatPlayer {
  return mkPlayer({
    seat,
    user_id: `opp${seat}`,
    username: `opp${seat}`,
    cards: [],
    ...over,
  } as never);
}

describe('V15 preflop normalization per hole count', () => {
  it('plo6 median hands stop scoring like premiums', () => {
    // Sample random 4/5/6 card hands under the seeded RNG-independent scorer
    // and compare medians. Pre-fix the plo6 median was 0.53 (above the 0.52
    // facing-a-raise call threshold); the fix aligns it with plo4's ~0.24.
    const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const SUITS = [h, d, s, cl];
    const deck: Card[] = [];
    for (const su of SUITS) for (const r of RANKS) deck.push(c(r, su));
    let x = 12345;
    const rnd = () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x / 0x100000000;
    };
    const median = (hole: number): number => {
      const scores: number[] = [];
      for (let i = 0; i < 4000; i++) {
        const dk = deck.slice();
        for (let j = 0; j < hole; j++) {
          const k = j + Math.floor(rnd() * (dk.length - j));
          const t = dk[j];
          dk[j] = dk[k];
          dk[k] = t;
        }
        scores.push(omahaPreflopScore(dk.slice(0, hole), false));
      }
      scores.sort((a, b) => a - b);
      return scores[2000];
    };
    const m4 = median(4);
    const m5 = median(5);
    const m6 = median(6);
    // Aligned distributions: the medians agree within a few points.
    expect(Math.abs(m5 - m4)).toBeLessThan(0.06);
    expect(Math.abs(m6 - m4)).toBeLessThan(0.06);
    // And nowhere near the pre-fix inflation (plo6 median was ~0.53).
    expect(m6).toBeLessThan(0.35);
  });
});

describe('omahaNutStatus', () => {
  const board3s = [c('K', s), c('9', s), c('4', s), c('7', d)]; // turn, 3 spades
  it('nut flush reads as zero higher flush ranks', () => {
    const hole = [c('A', s), c('2', s), c('J', d), c('J', cl)];
    const st = omahaNutStatus(hole, board3s);
    expect(st.category).toBe(6);
    expect(st.higherFlushRanks).toBe(0);
  });
  it('a nine-high... an eight-high flush knows it is dominated', () => {
    const hole = [c('8', s), c('2', s), c('J', d), c('J', cl)];
    const st = omahaNutStatus(hole, board3s);
    expect(st.category).toBe(6);
    // Live above the 8: A, Q, J, 10 (K and 9 are on the board) = 4+
    expect(st.higherFlushRanks).toBeGreaterThanOrEqual(4);
  });
  it('second nut flush reads as exactly one higher rank', () => {
    const hole = [c('Q', s), c('2', s), c('J', d), c('J', cl)];
    const st = omahaNutStatus(hole, board3s);
    expect(st.category).toBe(6);
    expect(st.higherFlushRanks).toBe(1); // only the As is live above the Q
  });
  it('nut straight vs dominated straight', () => {
    const board = [c('9', h), c('T', d), c('J', s), c('2', cl)];
    const nut = omahaNutStatus([c('K', h), c('Q', d), c('3', s), c('4', cl)], board);
    expect(nut.category).toBe(5);
    expect(nut.straightIsNut).toBe(true);
    const low = omahaNutStatus([c('8', h), c('Q', d), c('3', s), c('4', cl)], board);
    expect(low.category).toBe(5);
    expect(low.straightIsNut).toBe(false);
  });
});

/** Dan's hand: plo6 river, hero holds a nine-high flush on a three-spade
 *  board, hero bet, opponent raised big. Pre-fix the horse called off (or
 *  worse, reraised). Post-fix it must NEVER raise or jam, and it must fold
 *  the clear majority of the time. */
describe('the nine-high flush does not pay off the bigger flush', () => {
  const board = [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)];
  const hole6 = [c('9', s), c('6', s), c('A', h), c('J', d), c('3', cl), c('8', h)];

  function play(seed: number) {
    seedFastRandom(seed);
    const history: ActionRecord[] = [
      { seat: 1, userId: 'hero', action: 'bet', amount: 60, timestamp: 1, stage: 'river' },
      { seat: 3, userId: 'opp3', action: 'raise', amount: 240, timestamp: 2, stage: 'river' },
    ] as ActionRecord[];
    const hero = mkPlayer({ cards: hole6, bet: 60, stack: 740 });
    const gs: HorseGameStateV2 = {
      players: [hero, opp(3, { bet: 240, stack: 500 })],
      communityCards: board,
      pot: 420,
      currentBet: 240,
      minRaise: 180,
      lastRaise: 180,
      stage: 'river',
      gameVariant: 'plo6',
      bigBlind: 2,
      dealerSeat: 3,
      actionHistory: history,
      gameMode: 'cash',
      format: 'cash',
    } as HorseGameStateV2;
    return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
  }

  it(
    'never raises or jams into the river raise',
    () => {
      for (let seed = 1; seed <= 300; seed++) {
        const dec = play(seed * 7919);
        expect(['fold', 'call']).toContain(dec.action);
      }
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'folds the clear majority of the time',
    () => {
      let folds = 0;
      for (let seed = 1; seed <= 300; seed++) {
        if (play(seed * 104729).action === 'fold') folds++;
      }
      expect(folds / 300).toBeGreaterThan(0.6);
    },
    SUITE_TIMEOUT_MS
  );
});

/** The check-shove: plo4 turn, hero checked a small flush, opponent bet pot,
 *  SPR is low. Pre-fix the committed branch turned "call" into "all_in" off
 *  inflated equity. Post-fix a dominated flush may call but never jam. */
describe('the small flush check-calls instead of check-shoving', () => {
  const board = [c('Q', h), c('8', h), c('3', h), c('J', cl)];
  const hole = [c('7', h), c('5', h), c('K', d), c('9', s)];

  it(
    'never converts the call into a jam',
    () => {
      for (let seed = 1; seed <= 300; seed++) {
        seedFastRandom(seed * 6151);
        const history: ActionRecord[] = [
          { seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 1, stage: 'turn' },
          { seat: 2, userId: 'opp2', action: 'bet', amount: 100, timestamp: 2, stage: 'turn' },
        ] as ActionRecord[];
        const hero = mkPlayer({ cards: hole, stack: 120 });
        const gs: HorseGameStateV2 = {
          players: [hero, opp(2, { bet: 100, stack: 400 })],
          communityCards: board,
          pot: 200,
          currentBet: 100,
          minRaise: 100,
          lastRaise: 100,
          stage: 'turn',
          gameVariant: 'plo4',
          bigBlind: 2,
          dealerSeat: 2,
          actionHistory: history,
          gameMode: 'cash',
          format: 'cash',
        } as HorseGameStateV2;
        const dec = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
        expect(dec.action).not.toBe('all_in');
        expect(dec.action).not.toBe('raise');
      }
    },
    SUITE_TIMEOUT_MS
  );
});

/** Regression guard: the NUT flush stays aggressive. Discipline must not
 *  neuter the hands that are supposed to raise. */
describe('the nut flush still plays like the nuts', () => {
  const board = [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)];
  const hole = [c('A', s), c('6', s), c('A', h), c('J', d)];

  it('raises or calls the river raise, never folds', () => {
    let aggressive = 0;
    for (let seed = 1; seed <= 200; seed++) {
      seedFastRandom(seed * 3571);
      const history: ActionRecord[] = [
        { seat: 1, userId: 'hero', action: 'bet', amount: 60, timestamp: 1, stage: 'river' },
        { seat: 3, userId: 'opp3', action: 'raise', amount: 240, timestamp: 2, stage: 'river' },
      ] as ActionRecord[];
      const hero = mkPlayer({ cards: hole, bet: 60, stack: 740 });
      const gs: HorseGameStateV2 = {
        players: [hero, opp(3, { bet: 240, stack: 500 })],
        communityCards: board,
        pot: 420,
        currentBet: 240,
        minRaise: 180,
        lastRaise: 180,
        stage: 'river',
        gameVariant: 'plo4',
        bigBlind: 2,
        dealerSeat: 3,
        actionHistory: history,
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
      expect(dec.action).not.toBe('fold');
      if (dec.action === 'raise' || dec.action === 'all_in') aggressive++;
    }
    expect(aggressive).toBeGreaterThan(0);
  });
});

/** Board demotions (line-by-line sweep): a nut straight is not the nuts on a
 *  three-flush board, and a flush is not the nuts on a paired board. When
 *  raised there, both take the check-call line - never the raise. */
describe('board demotes the nuts', () => {
  function playRaised(seed: number, hole: Card[], board: Card[], variant: string) {
    seedFastRandom(seed);
    const history: ActionRecord[] = [
      { seat: 1, userId: 'hero', action: 'bet', amount: 60, timestamp: 1, stage: 'river' },
      { seat: 3, userId: 'opp3', action: 'raise', amount: 240, timestamp: 2, stage: 'river' },
    ] as ActionRecord[];
    const hero = mkPlayer({ cards: hole, bet: 60, stack: 740 });
    const gs: HorseGameStateV2 = {
      players: [hero, opp(3, { bet: 240, stack: 500 })],
      communityCards: board,
      pot: 420,
      currentBet: 240,
      minRaise: 180,
      lastRaise: 180,
      stage: 'river',
      gameVariant: variant,
      bigBlind: 2,
      dealerSeat: 3,
      actionHistory: history,
      gameMode: 'cash',
      format: 'cash',
    } as HorseGameStateV2;
    return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
  }

  it('nut straight on a three-flush board never raises the raise', () => {
    const board = [c('9', h), c('T', h), c('J', h), c('2', cl), c('3', d)];
    const hole = [c('K', s), c('Q', d), c('7', cl), c('4', s)];
    for (let seed = 1; seed <= 150; seed++) {
      const dec = playRaised(seed * 7013, hole, board, 'plo4');
      expect(['fold', 'call']).toContain(dec.action);
    }
  });

  it('nut flush on a paired board never raises the raise', () => {
    const board = [c('K', s), c('T', s), c('4', s), c('4', d), c('2', h)];
    const hole = [c('A', s), c('6', s), c('Q', d), c('J', cl)];
    for (let seed = 1; seed <= 150; seed++) {
      const dec = playRaised(seed * 9109, hole, board, 'plo4');
      expect(['fold', 'call']).toContain(dec.action);
    }
  });
});

/** plo6 league smoke: the variant-generic playHand deals 6 cards, enforces
 *  pot-limit, and conserves chips with zero illegal actions. */
describe('league hands are legal and conserve chips across every V16 configuration', () => {
  it(
    'plo6 6-max 100bb: 100 hands, zero illegal, chips conserved',
    async () => {
      const { playHand } = await import('../benchmark/HorseLeague.js');
      const counters = { illegal: 0, truncated: 0 };
      for (let hnd = 0; hnd < 100; hnd++) {
        const net = playHand(
          4242 + hnd * 7919,
          (hnd % 6) + 1,
          () => ({}),
          counters,
          undefined,
          'plo6'
        );
        const sum = net.reduce((a, b) => a + b, 0);
        expect(Math.abs(sum)).toBeLessThan(1e-6);
      }
      expect(counters.illegal).toBe(0);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'heads-up, 40bb, plo8 and short_deck deals all stay legal and conserved',
    async () => {
      const { playHand } = await import('../benchmark/HorseLeague.js');
      const configs: Array<{ variant: string; seats: number; stackBB: number }> = [
        { variant: 'nlh', seats: 2, stackBB: 100 },
        { variant: 'nlh', seats: 6, stackBB: 40 },
        { variant: 'plo8', seats: 6, stackBB: 100 },
        { variant: 'short_deck', seats: 6, stackBB: 100 },
        { variant: 'plo4', seats: 2, stackBB: 60 },
      ];
      for (const cfg of configs) {
        const counters = { illegal: 0, truncated: 0 };
        for (let hnd = 0; hnd < 60; hnd++) {
          const net = playHand(
            9000 + hnd * 6151,
            (hnd % cfg.seats) + 1,
            () => ({}),
            counters,
            undefined,
            cfg.variant,
            cfg.seats,
            cfg.stackBB
          );
          expect(net).toHaveLength(cfg.seats);
          const sum = net.reduce((a, b) => a + b, 0);
          expect(Math.abs(sum)).toBeLessThan(1e-6);
        }
        expect(counters.illegal).toBe(0);
      }
    },
    SUITE_TIMEOUT_MS
  );
});
