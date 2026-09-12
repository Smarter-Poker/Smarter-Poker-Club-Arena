/**
 * EVERY DIAMOND CONFIGURATION THE ARENA CAN OPEN (2026-09-12, Phase 7 line seven).
 *
 * Phase 7 line seven asks for lifecycle and denomination regressions ACROSS
 * CONFIGURATIONS, and the arena now has more than one. Straddles arrived on
 * September 12 and run it twice with them, so a Diamond table is no longer a
 * single shape: it is a small matrix, and each cell has to be admitted, dealt
 * and conserved rather than only the one that happened to be tested.
 *
 * The stake ladder below is the one Dan set on September 11 - the Club Arena
 * NLH ladder at one Diamond to the cent - and it is here because a denomination
 * regression that only tries 1/2 proves nothing about 5000/10000, where a
 * buy-in is two million Diamonds and every guard is a safe-integer check.
 */
import { describe, expect, it } from 'vitest';
import { assertDiamondCashTable } from '../domain/DiamondCashBoundary.js';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

/** A table the boundary admits: every deduction zero, every run-it stated. */
const plain = {
  game_variant: 'nlh',
  tournament_id: null,
  cluster_id: null,
  status: 'waiting',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 80,
  max_buy_in: 400,
  ante: 0,
  rake_percent: 0,
  rake_cap_bb: 0,
  bbj_percent: 0,
  run_it_twice: false,
  allow_run_it_twice: false,
} as Record<string, unknown>;

/** Dan's ladder, September 11 2026: the Club Arena NLH stakes, one Diamond to
 *  the cent. `[small, big, min buy-in, max buy-in]`. */
const LADDER: Array<[number, number, number, number]> = [
  [1, 2, 80, 400],
  [2, 5, 200, 1000],
  [5, 10, 400, 2000],
  [10, 20, 800, 4000],
  [10, 25, 1000, 5000],
  [25, 50, 2000, 10000],
  [50, 100, 4000, 20000],
  [100, 200, 8000, 40000],
  [200, 400, 16000, 80000],
  [200, 500, 20000, 100000],
  [300, 600, 24000, 120000],
  [400, 800, 32000, 160000],
  [500, 1000, 40000, 200000],
  [1000, 2000, 80000, 400000],
  [1000, 2500, 100000, 500000],
  [2500, 5000, 200000, 1000000],
  [5000, 10000, 400000, 2000000],
];

/** The feature matrix a staff door can actually produce today. */
const FEATURES: Array<[string, Record<string, unknown>]> = [
  ['plain', {}],
  ['voluntary straddle', { straddle_enabled: true, voluntary_straddle: true }],
  ['mandatory UTG straddle', { straddle_enabled: true, auto_utg_straddle: true }],
  ['run it twice', { run_it_twice: true, allow_run_it_twice: true }],
  ['run it twice by the third column', { run_it_twice_enabled: true }],
  [
    'straddles and run it twice together',
    {
      straddle_enabled: true,
      voluntary_straddle: true,
      run_it_twice: true,
      allow_run_it_twice: true,
    },
  ],
];

const LIVE_STATUSES = ['waiting', 'running', 'playing', 'active'];

function players(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `p${i + 1}`,
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

function handConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    asset: 'diamonds',
    tableId: 'diamond-configuration-matrix',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

describe('a Diamond table is admitted in every shape the arena can open', () => {
  it.each(FEATURES)('%s, at every live status', (_name, feature) => {
    for (const status of LIVE_STATUSES) {
      expect(() => assertDiamondCashTable({ ...plain, ...feature, status })).not.toThrow();
    }
    /* And nowhere else. A closed table is not a configuration. */
    for (const status of ['closed', 'completed', 'cancelled', 'archived', 'deleted']) {
      expect(() => assertDiamondCashTable({ ...plain, ...feature, status })).toThrow(
        'Diamond Plain Cash Table Required'
      );
    }
  });

  it.each(LADDER)('the %i/%i rung is admitted in every shape', (sb, bb, min, max) => {
    for (const [, feature] of FEATURES) {
      expect(() =>
        assertDiamondCashTable({
          ...plain,
          ...feature,
          small_blind: sb,
          big_blind: bb,
          min_buy_in: min,
          max_buy_in: max,
        })
      ).not.toThrow();
    }
  });
});

describe('every rung of the ladder deals and conserves in whole Diamonds', () => {
  it.each(LADDER)('%i/%i, a full hand at the maximum buy-in', (sb, bb, _min, max) => {
    const stacks = [max, max, max];
    const hc = new HandController(
      handConfig({ smallBlind: sb, bigBlind: bb, ritEnabled: true }),
      players(stacks),
      1
    );
    hc.start();
    for (let step = 0; step < 40 && hc.getState().stage !== 'showdown'; step++) {
      const state = hc.getState();
      const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!player || player.is_all_in) {
        hc.continueRunout();
        continue;
      }
      expect(hc.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check')).toBe(
        true
      );
    }
    expect(hc.getState().stage).toBe('showdown');
    const after = hc.getState().players;
    expect(after.reduce((s, p) => s + p.stack, 0)).toBe(stacks.reduce((s, x) => s + x, 0));
    for (const p of after) {
      expect(Number.isSafeInteger(p.stack), `${p.user_id} holds ${p.stack} at ${sb}/${bb}`).toBe(
        true
      );
    }
  });

  it('the largest rung is still nowhere near the guard ceiling', () => {
    /* Every Diamond guard is a 32-bit check: a stack, a buy-in and a pot must
       each fit in 2147483647. Three players at the top rung is six million,
       which is the number this asserts is still small. */
    const top = LADDER[LADDER.length - 1];
    expect(top[3] * 3).toBeLessThan(2147483647);
    expect(() =>
      assertDiamondCashTable({
        ...plain,
        small_blind: top[0],
        big_blind: top[1],
        min_buy_in: top[2],
        max_buy_in: 2147483648,
      })
    ).toThrow('Diamond Cash Requires Whole Positive Amounts');
  });
});

describe('a configuration the arena cannot open is refused, one reason at a time', () => {
  it.each([
    ['insurance', { insurance_enabled: true }],
    ['a bomb pot', { bomb_pot_enabled: true }],
    ['the seven-deuce side bet', { seven_deuce_enabled: true }],
    ['a nit game', { nit_game: true }],
    ['all in or fold', { all_in_or_fold: true }],
    ['pineapple', { pineapple_holdem: true }],
    ['a betting cap', { cap_enabled: true }],
    ['a template', { is_template: true }],
    ['a variant beyond NLH', { game_variant: 'plo4' }],
    ['a tournament table', { tournament_id: 't' }],
    ['a cluster table', { cluster_id: 'c' }],
    ['rake', { rake_percent: 1 }],
    ['a rake cap', { rake_cap_bb: 1 }],
    ['a jackpot percentage', { bbj_percent: 1 }],
    ['an unset rake percentage', { rake_percent: null }],
    ['an unset rake cap', { rake_cap_bb: null }],
    ['an unset jackpot percentage', { bbj_percent: null }],
    ['an unset run-it column', { run_it_twice: null }],
    ['an unset allow-run-it column', { allow_run_it_twice: null }],
    ['a fractional small blind', { small_blind: 0.5 }],
    ['a zero minimum buy-in', { min_buy_in: 0 }],
    ['an infinite maximum buy-in', { max_buy_in: Infinity }],
    ['a fractional ante', { ante: 0.5 }],
  ])('%s', (_why, change) => {
    /* Refused on its own, and still refused next to every feature the arena
       CAN open - a permitted flag must never launder a forbidden one. */
    for (const [, feature] of FEATURES) {
      expect(() => assertDiamondCashTable({ ...plain, ...feature, ...change })).toThrow();
    }
  });
});
