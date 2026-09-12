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
import { assertDiamondCashTable, DIAMOND_CASH_VARIANTS } from '../domain/DiamondCashBoundary.js';
import { HandController } from './HandController.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
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
  ['a bomb pot', { bomb_pot_enabled: true }],
  ['a bomb pot on a fixed ante', { bomb_pot_enabled: true, bomb_pot_ante_fixed: 5 }],
  [
    'a three-board bomb pot',
    { bomb_pot_enabled: true, bomb_pot_board_count: 3, bomb_pot_double_board: true },
  ],
  [
    'everything the arena can open at once',
    {
      straddle_enabled: true,
      voluntary_straddle: true,
      run_it_twice: true,
      allow_run_it_twice: true,
      bomb_pot_enabled: true,
    },
  ],
];

const LIVE_STATUSES = ['waiting', 'running', 'playing', 'active'];

/* THE FOURTH AXIS (2026-09-12). This matrix crossed features, statuses and
   rungs while the arena dealt one game. It deals nine now - the same nine the
   chip cash create screen offers - and a game is exactly the kind of thing
   that works in the cell nobody tested. Written as an array for the same
   reason the other three are: a tenth game joins it rather than forcing a
   rewrite. */
const VARIANTS = [...DIAMOND_CASH_VARIANTS];

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

  it.each(VARIANTS)('%s, in every shape and at every live status', (game_variant) => {
    for (const [, feature] of FEATURES) {
      for (const status of LIVE_STATUSES) {
        expect(() =>
          assertDiamondCashTable({ ...plain, ...feature, game_variant, status })
        ).not.toThrow();
      }
    }
  });

  it.each(VARIANTS)('%s may bomb in its own game and in no other', (game_variant) => {
    /* The bomb override names a game, and the rule is the TABLE's game rather
       than a literal. Both halves are asserted for every variant, because a
       rule that reads one literal and a rule that reads the row are
       indistinguishable until there is more than one row. */
    expect(() =>
      assertDiamondCashTable({
        ...plain,
        game_variant,
        bomb_pot_enabled: true,
        bomb_pot_variant: game_variant,
      })
    ).not.toThrow();
    for (const other of VARIANTS.filter((v) => v !== game_variant)) {
      expect(() =>
        assertDiamondCashTable({
          ...plain,
          game_variant,
          bomb_pot_enabled: true,
          bomb_pot_variant: other,
        })
      ).toThrow('Diamond Bomb Pots Require The Table Game');
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

  it.each(VARIANTS)('%s deals a full hand and conserves in whole Diamonds', async (gameVariant) => {
    /* One rung is enough here: the rung axis is covered above for the game the
       arena opened with, and what a NEW game changes is how the pot is cut,
       not how big it is. The top rung is the one where a fractional slice
       would be largest, so it is the one used. */
    const [sb, bb, , max] = LADDER[LADDER.length - 1];
    const stacks = [max, max, max];
    const hc = new HandController(
      handConfig({ smallBlind: sb, bigBlind: bb, gameVariant } as Record<string, unknown>),
      players(stacks),
      1
    );
    hc.start();
    for (let step = 0; step < 80 && hc.getState().stage !== 'showdown'; step++) {
      const state = hc.getState();
      /* Pineapple's discard is an ACTION, not a street to be checked through:
         the engine folds a seat that misses it. Every live seat discards its
         third card and the hand resumes. */
      if (state.stage === 'pineapple_discard') {
        for (const p of state.players) {
          if (!p.is_folded && hc.owesPineappleDiscard(p.seat)) {
            expect(hc.performDiscard(p.seat, 2), `${gameVariant} refused a discard`).toBe(true);
          }
        }
        /* The flop is held for DISCARD_SETTLE_MS after the last card is in, so
           the discard is visible before the board arrives. A synchronous loop
           never yields and the timer never fires, so this waits for the beat
           rather than spinning through it. */
        await new Promise((resolve) => setTimeout(resolve, HAND_COMPLETION.DISCARD_SETTLE_MS + 50));
        continue;
      }
      const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!player || player.is_all_in) {
        hc.continueRunout();
        continue;
      }
      const action = player.bet < state.currentBet ? 'call' : 'check';
      expect(hc.performAction(player.seat, action), `${gameVariant} refused a ${action}`).toBe(
        true
      );
    }
    expect(hc.getState().stage, `${gameVariant} never reached showdown`).toBe('showdown');
    const after = hc.getState().players;
    expect(after.reduce((s, p) => s + p.stack, 0)).toBe(stacks.reduce((s, x) => s + x, 0));
    for (const p of after) {
      expect(
        Number.isSafeInteger(p.stack),
        `${p.user_id} holds ${p.stack} after a hand of ${gameVariant}`
      ).toBe(true);
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
    ['the seven-deuce side bet', { seven_deuce_enabled: true }],
    ['a nit game', { nit_game: true }],
    ['all in or fold', { all_in_or_fold: true }],
    ['pineapple', { pineapple_holdem: true }],
    ['a betting cap', { cap_enabled: true }],
    ['a template', { is_template: true }],
    /* `plo4` was here until 2026-09-12; the nine games the chip cash screen
       offers are admitted now, and a game nobody deals takes its place. The
       admitted nine are asserted positively further down. */
    ['a game this estate does not deal', { game_variant: 'razz' }],
    ['a variant that is not a variant', { game_variant: '' }],
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

  /* The bomb columns bind only while the feature is on, so they are their own
     pair rather than another row above: a stale multiplier on a table that is
     not bombing is not a reason to refuse the table. */
  it.each([
    ['an ante that is not a whole Diamond', { big_blind: 1, bomb_pot_ante_multiplier: 1.5 }],
    ['a fixed ante that is not a whole Diamond', { bomb_pot_ante_fixed: 2.5 }],
    ['an ante of nothing', { bomb_pot_ante_multiplier: 0 }],
    ['bombs in a game the table is not certified for', { bomb_pot_variant: 'plo4' }],
  ])('a bomb pot with %s is refused', (_why, change) => {
    expect(() => assertDiamondCashTable({ ...plain, bomb_pot_enabled: true, ...change })).toThrow();
    /* And the same row with bombs OFF is fine, which is what makes the refusal
       about the bomb rather than about the column. */
    expect(() =>
      assertDiamondCashTable({ ...plain, bomb_pot_enabled: false, ...change })
    ).not.toThrow();
  });
});
