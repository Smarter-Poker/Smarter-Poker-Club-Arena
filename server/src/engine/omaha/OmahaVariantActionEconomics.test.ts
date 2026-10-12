import { describe, expect, it } from 'vitest';
import type { RakeConfig, SeatPlayer } from '../../types.js';
import type { HorseEquityOutcomeSample } from '../HorseEval.js';
import {
  OMAHA_VARIANT_ACTION_ECONOMICS_VERSION,
  omahaVariantActionEconomics,
  omahaVariantActionEconomicsIsValid,
  type OmahaVariantActionEconomicsInput,
} from './OmahaVariantActionEconomics.js';

/**
 * P11-A (audit 2026-10-07): the PLO5/PLO6/PLO8 river net-action result.
 * Every expected number is derived in the comment beside it from the hand's
 * own chips, never from another call into the module and never from the
 * pot-share estimator.
 */

const seat = (
  user_id: string,
  seatNo: number,
  stack: number,
  bet: number,
  totalInvested: number,
  extra: Partial<SeatPlayer> = {}
): SeatPlayer => ({
  user_id,
  username: user_id,
  seat: seatNo,
  stack,
  bet,
  totalInvested,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  ...extra,
});
const sample = (
  heroHigh: number,
  heroLow: number | null,
  opponentHigh: number[],
  opponentLow: Array<number | null>
): HorseEquityOutcomeSample => ({
  heroHigh,
  heroLow,
  opponentHigh,
  opponentLow,
  opponentDecisionStrength: opponentHigh.map(() => 0.5),
});
const NO_RAKE: RakeConfig = { percent: 0, cap: 0, noFlopNoDrop: true };

// Heads-up PLO8 river: hero (seat 1, the button) has 20 in and 100 behind;
// the villain bet 20 into it and has 80 behind. Pot 60, call 20.
const HU = [seat('hero', 1, 100, 0, 20), seat('v2', 2, 80, 20, 40)];
// The four terminal showdowns: a scoop, high plus a tied low, low only, and
// no qualifying low with the high lost.
const SCOOP = sample(900, 50, [100], [null]);
const SPLIT_LOW = sample(900, 50, [100], [50]);
const LOW_ONLY = sample(100, 50, [900], [null]);
const LOSE = sample(100, null, [900], [null]);

function input(
  over: Partial<OmahaVariantActionEconomicsInput> = {}
): OmahaVariantActionEconomicsInput {
  return {
    variant: 'plo8',
    stage: 'river',
    hero: HU[0],
    players: HU,
    opponentIds: ['v2'],
    samples: [SCOOP, SPLIT_LOW, LOW_ONLY, LOSE],
    currentBet: 20,
    legalActions: ['fold', 'call', 'raise'],
    minRaiseTo: 40,
    maxRaiseTo: 100,
    wagerSizes: [40, 100],
    chipUnit: 0.01,
    asset: 'chips',
    gameMode: 'cash',
    bigBlind: 2,
    dealerSeat: 1,
    rakeConfig: NO_RAKE,
    bbjConfig: null,
    now: () => 0,
    ...over,
  };
}
const line = (
  r: ReturnType<typeof omahaVariantActionEconomics>,
  action: string,
  response: string,
  amount: number | null = null
) =>
  r.values.find(
    (v) =>
      v.action === action && v.response === response && (amount === null || v.amount === amount)
  )!;

describe('P11-A PLO8 river net chips, settled through the platform owners', () => {
  it('prices fold, call and both wager sizes under both responses', () => {
    const r = omahaVariantActionEconomics(input());
    expect(r.unavailable).toBeNull();
    expect(r.version).toBe(OMAHA_VARIANT_ACTION_ECONOMICS_VERSION);
    expect(r.scoring).toBe('high_low_split');
    expect(r.wagerBounds).toEqual({ minRaiseTo: 40, maxRaiseTo: 100, priced: [40, 100] });
    expect(line(r, 'fold', 'terminal_showdown').netChips).toBe(0);
    // Call: pot 80. Scoop 80-20 = 60; high 40 plus half the tied low 20 is
    // 60-20 = 40; low only 40-20 = 20; nothing -20. Mean 25.
    const call = line(r, 'call', 'terminal_showdown');
    expect(call).toMatchObject({
      committed: 20,
      netChips: 25,
      worstNetChips: -20,
      bestNetChips: 60,
      refund: 0,
      rake: 0,
      bbjFee: 0,
      samples: 4,
    });
    // Raise to 40, called: pot 120. 120-40 = 80; 60+30-40 = 50; 60-40 = 20;
    // -40. Mean 27.5.
    expect(line(r, 'raise', 'all_contesting_opponents_call', 40)).toMatchObject({
      committed: 40,
      netChips: 27.5,
      worstNetChips: -40,
      bestNetChips: 80,
    });
    // Raise to 100 (pot and hero's stack), called for the villain's last 80:
    // pot 240. 240-100 = 140; 120+60-100 = 80; 120-100 = 20; -100. Mean 35.
    expect(line(r, 'raise', 'all_contesting_opponents_call', 100)).toMatchObject({
      committed: 100,
      netChips: 35,
    });
    // Folded to: the uncalled excess comes back as a refund (20 over the
    // villain's 40, then 80) and hero takes the 80 contested: +60 either way.
    expect(line(r, 'raise', 'all_contesting_opponents_fold', 40)).toMatchObject({
      netChips: 60,
      refund: 20,
    });
    expect(line(r, 'raise', 'all_contesting_opponents_fold', 100)).toMatchObject({
      netChips: 60,
      refund: 80,
    });
    // The first greatest line is named.
    expect(r.best).toEqual({
      action: 'raise',
      response: 'all_contesting_opponents_fold',
      amount: 40,
    });
    expect(omahaVariantActionEconomicsIsValid(r)).toBe(true);
  });

  it('values a low-only half and a scoop of the same nominal pot apart, and no low as high-only', () => {
    const scoop = omahaVariantActionEconomics(input({ samples: [SCOOP, SCOOP, SCOOP, SCOOP] }));
    const lowOnly = omahaVariantActionEconomics(
      input({ samples: [LOW_ONLY, LOW_ONLY, LOW_ONLY, LOW_ONLY] })
    );
    const noLow = omahaVariantActionEconomics(input({ samples: [LOSE, LOSE, LOSE, LOSE] }));
    expect(line(scoop, 'call', 'terminal_showdown').netChips).toBe(60);
    expect(line(lowOnly, 'call', 'terminal_showdown').netChips).toBe(20);
    // No qualifying low: the high takes the whole pot.
    expect(line(noLow, 'call', 'terminal_showdown').netChips).toBe(-20);
  });

  it('returns the excess of hero over a short caller before settling', () => {
    // The villain has only 30 behind. Hero raises to 100 and is called all
    // in: the villain's 70 matches 70 of hero's 120, so 50 comes back. Pot
    // 140, scooped: stack change -100 + 50 + 140 = +90.
    const players = [seat('hero', 1, 100, 0, 20), seat('v2', 2, 30, 20, 40)];
    const r = omahaVariantActionEconomics(
      input({ players, hero: players[0], samples: [SCOOP, SCOOP, SCOOP, SCOOP], wagerSizes: [100] })
    );
    expect(line(r, 'raise', 'all_contesting_opponents_call', 100)).toMatchObject({
      committed: 100,
      refund: 50,
      netChips: 90,
    });
  });

  it('a quarter is a quarter of the pot in chips', () => {
    // Three-way: hero calls 20 into two 40s. Pot 120. The villain at seat 2
    // wins the high (60); hero and seat 3 tie the low (30 each): 30-20 = 10.
    const players = [
      seat('hero', 1, 100, 0, 20),
      seat('v2', 2, 80, 20, 40),
      seat('v3', 3, 80, 20, 40),
    ];
    const r = omahaVariantActionEconomics(
      input({
        players,
        hero: players[0],
        opponentIds: ['v2', 'v3'],
        samples: Array.from({ length: 4 }, () => sample(100, 60, [900, 200], [null, 60])),
        wagerSizes: [],
        legalActions: ['fold', 'call'],
      })
    );
    expect(line(r, 'call', 'terminal_showdown').netChips).toBe(10);
    expect(r.wagerBounds).toBeNull();
  });

  it('a short all-in wins the main pot while hero wins the side pot', () => {
    // PLO5. Seat 2 is all in for 30; seat 3 has bet 30. Hero calls 30: main
    // pot 3 x 30 = 90 (seat 2 wins it), side pot 2 x 20 = 40 (hero beats
    // seat 3): 40-30 = 10.
    const players = [
      seat('hero', 1, 100, 0, 20),
      seat('v2', 2, 0, 10, 30, { is_all_in: true }),
      seat('v3', 3, 70, 30, 50),
    ];
    const r = omahaVariantActionEconomics(
      input({
        variant: 'plo5',
        players,
        hero: players[0],
        opponentIds: ['v2', 'v3'],
        currentBet: 30,
        samples: Array.from({ length: 4 }, () => sample(500, null, [900, 100], [null, null])),
        wagerSizes: [],
        legalActions: ['fold', 'call'],
      })
    );
    expect(r.scoring).toBe('high_only');
    expect(line(r, 'call', 'terminal_showdown').netChips).toBe(10);
  });

  it('allocates an odd cent of a split low as the controller does', () => {
    // Villain bet 20.01: pot after the call 80.02 = 8,002 cents. High half
    // 4,001 to hero; low half 4,001 split by the tie, the odd cent to seat 2
    // (clockwise of the button first), so hero gets 2,000. 60.01-20.01 = 40.
    const players = [seat('hero', 1, 100, 0, 20), seat('v2', 2, 79.99, 20.01, 40.01)];
    const r = omahaVariantActionEconomics(
      input({
        players,
        hero: players[0],
        currentBet: 20.01,
        samples: [SPLIT_LOW, SPLIT_LOW, SPLIT_LOW, SPLIT_LOW],
        wagerSizes: [],
        legalActions: ['fold', 'call'],
      })
    );
    expect(line(r, 'call', 'terminal_showdown')).toMatchObject({ committed: 20.01, netChips: 40 });
  });

  it('charges rake and the BBJ fee through the deduction owner, contrasted with zero fees', () => {
    const scoops = [SCOOP, SCOOP, SCOOP, SCOOP];
    const free = line(
      omahaVariantActionEconomics(input({ samples: scoops })),
      'call',
      'terminal_showdown'
    );
    const rake: RakeConfig = { percent: 5, cap: 10, noFlopNoDrop: true };
    const raked = line(
      omahaVariantActionEconomics(input({ samples: scoops, rakeConfig: rake })),
      'call',
      'terminal_showdown'
    );
    const bbj = line(
      omahaVariantActionEconomics(
        input({
          samples: scoops,
          rakeConfig: rake,
          bbjConfig: { enabled: true, feeBB: 0.5, minPotBB: 0, minPlayersDealt: 2 },
        })
      ),
      'call',
      'terminal_showdown'
    );
    // Pot 80: 5% rake is 4 under the cap of 10; the BBJ fee is 0.5 BB = 1.
    expect(free).toMatchObject({ netChips: 60, rake: 0, bbjFee: 0 });
    expect(raked).toMatchObject({ netChips: 56, rake: 4, bbjFee: 0 });
    expect(bbj).toMatchObject({ netChips: 55, rake: 4, bbjFee: 1 });
    // A cap below the percentage binds.
    const capped = line(
      omahaVariantActionEconomics(
        input({ samples: scoops, rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true } })
      ),
      'call',
      'terminal_showdown'
    );
    expect(capped).toMatchObject({ netChips: 57, rake: 3 });
  });
});

describe('P11-A refusals are named, never empty', () => {
  it.each([
    ['variant_outside_net_action_slice', { variant: 'plo4' }],
    ['street_outside_net_action_slice', { stage: 'turn' }],
    ['terminal_samples_unavailable', { samples: [SCOOP, SCOOP, SCOOP] }],
    ['contesting_roster_mismatch', { opponentIds: ['v9'] }],
    ['terminal_samples_rejected', { variant: 'plo5' }],
    ['wager_bounds_unavailable', { wagerSizes: [39] }],
    ['wager_bounds_unavailable', { wagerSizes: [101] }],
    ['wager_bounds_unavailable', { maxRaiseTo: 80 }],
    ['wager_bounds_unavailable', { wagerSizes: [40], legalActions: ['fold', 'call'] }],
    ['canonical_input_unavailable', { dealerSeat: 0 }],
  ] as const)('%s', (reason, over) => {
    const r = omahaVariantActionEconomics(input(over as Partial<OmahaVariantActionEconomicsInput>));
    expect(r.unavailable).toBe(reason);
    expect(r.values).toEqual([]);
    expect(r.best).toBeNull();
    expect(omahaVariantActionEconomicsIsValid(r)).toBe(true);
  });

  it('an exhausted budget prices nothing rather than a partial comparison', () => {
    let calls = 0;
    const r = omahaVariantActionEconomics(input({ withinBudget: () => ++calls < 5 }));
    expect(r.unavailable).toBe('work_budget_unavailable');
    expect(r.budgetExhausted).toBe(true);
    expect(r.values).toEqual([]);
    const none = omahaVariantActionEconomics(input({ withinBudget: () => false }));
    expect(none.unavailable).toBe('work_budget_unavailable');
  });
});

describe('P11-A receipt validator', () => {
  const good = () => JSON.parse(JSON.stringify(omahaVariantActionEconomics(input())));
  it('accepts the module output and refuses every tampering', () => {
    expect(omahaVariantActionEconomicsIsValid(good())).toBe(true);
    const mutations: Array<(v: ReturnType<typeof good>) => void> = [
      (v) => (v.version = 'omaha-variant-action-economics-v0'),
      (v) => (v.scoring = 'high_only'),
      (v) => (v.best.amount = 100),
      (v) => (v.values[0].netChips = 1),
      (v) => (v.values[2].amount = 50),
      (v) => (v.values[1].response = 'all_contesting_opponents_call'),
      (v) => (v.unavailable = 'work_budget_unavailable'),
      (v) => (v.wagerBounds.priced = [100, 40]),
      (v) => (v.values[1].samples = 3),
      (v) => (v.extra = true),
      (v) => v.values.push({ ...v.values[1] }),
    ];
    for (const mutate of mutations) {
      const v = good();
      mutate(v);
      expect(omahaVariantActionEconomicsIsValid(v), mutate.toString()).toBe(false);
    }
  });
});
