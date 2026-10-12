import { describe, expect, it } from 'vitest';
import type { ActionRecord, HandConfig, RakeConfig, SeatPlayer } from '../../types.js';
import type { HorseEquityOutcomeSample } from '../HorseEval.js';
import { HandController } from '../HandController.js';
import {
  MIN_TERMINAL_SAMPLES,
  REMAINING_VARIANT_ACTION_ECONOMICS_VERSION,
  remainingVariantActionEconomics,
  remainingVariantActionEconomicsIsValid,
  type RemainingVariantActionEconomicsInput,
} from './RemainingVariantActionEconomics.js';

/**
 * P12.1 net-action economics. Every expected number below is derived in the
 * comment beside it from the hand's own chips, NOT from another call into the
 * module under test and not from the live policy's pot-share estimator.
 */

const seat = (
  user_id: string,
  seatNumber: number,
  stack: number,
  bet: number,
  totalInvested: number,
  extra: Partial<SeatPlayer> = {}
): SeatPlayer => ({
  user_id,
  username: user_id,
  seat: seatNumber,
  stack,
  bet,
  totalInvested,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  ...extra,
});

const NO_RAKE: RakeConfig = { percent: 0, cap: 0, noFlopNoDrop: true };
const FIVE_PERCENT: RakeConfig = { percent: 5, cap: 10, noFlopNoDrop: true };

/** One terminal river showdown. `heroHigh` higher wins; `low` lower wins. */
const showdown = (
  heroHigh: number,
  opponentHigh: number[],
  heroLow: number | null = null,
  opponentLow: Array<number | null> = opponentHigh.map(() => null)
): HorseEquityOutcomeSample => ({
  heroHigh,
  opponentHigh,
  heroLow,
  opponentLow,
  opponentDecisionStrength: opponentHigh.map(() => 0.5),
});

const RIVER_BET_HISTORY: ActionRecord[] = [
  {
    userId: 'v3',
    seat: 2,
    action: 'bet',
    amount: 4,
    stage: 'river',
    timestamp: 1,
    isFullRaise: true,
  },
];

/**
 * FLH heads-up river, 2/4 limit (bigBlind 2, river big bet 4), no fees.
 * Hero has 20 in and faces a 4 bet from v3, who has 24 in. Pot 44.
 */
function flhHeadsUp(
  overrides: Partial<RemainingVariantActionEconomicsInput> = {}
): RemainingVariantActionEconomicsInput {
  const players = [seat('hero', 1, 100, 0, 20), seat('v3', 2, 100, 4, 24)];
  return {
    variant: 'flh',
    stage: 'river',
    hero: players[0],
    players,
    opponentIds: ['v3'],
    samples: [],
    currentBet: 4,
    betSize: 4,
    actionHistory: RIVER_BET_HISTORY,
    legalActions: ['fold', 'call', 'raise'],
    wagersCapped: false,
    minRaiseTo: 8,
    maxRaiseTo: 8,
    chipUnit: 0.01,
    asset: 'chips',
    gameMode: 'cash',
    bigBlind: 2,
    dealerSeat: 1,
    rakeConfig: NO_RAKE,
    bbjConfig: null,
    now: () => 0,
    ...overrides,
  };
}

const valueFor = (
  result: ReturnType<typeof remainingVariantActionEconomics>,
  action: 'fold' | 'call' | 'raise',
  response: string
) => result.values.find((v) => v.action === action && v.response === response);

describe('P12.1 net-action economics price the actual chips', () => {
  // One win in four. Call: hero wins 48 once (48 - 4) and loses 4 three times,
  // so (44 - 4 - 4 - 4) / 4 = 8.00. Raise called: pot 56, (48 - 8 - 8 - 8) / 4
  // = 6.00. Raise folded through: hero wins the 48 pot his own 24 is in and
  // his uncalled 4 is refunded, 48 + 4 - 8 = 44.00, with no sampling at all.
  const oneWinInFour = [showdown(9, [1]), showdown(1, [9]), showdown(1, [9]), showdown(1, [9])];

  it('derives fold, call and both bracketing wager assumptions in net chips', () => {
    const result = remainingVariantActionEconomics(flhHeadsUp({ samples: oneWinInFour }));
    expect(result.unavailable).toBe(null);
    expect(result.version).toBe(REMAINING_VARIANT_ACTION_ECONOMICS_VERSION);
    expect(result.scoring).toBe('high_only');
    expect(result.wagerBounds).toEqual({
      betSize: 4,
      raiseSize: 4,
      raiseTo: 8,
      wagers: 1,
      completion: false,
      capped: false,
    });
    expect(valueFor(result, 'fold', 'terminal_showdown')).toMatchObject({
      netChips: 0,
      committed: 0,
      amount: null,
    });
    expect(valueFor(result, 'call', 'terminal_showdown')).toMatchObject({
      amount: 4,
      committed: 4,
      netChips: 8,
      worstNetChips: -4,
      bestNetChips: 44,
      rake: 0,
      bbjFee: 0,
      refund: 0,
      samples: 4,
    });
    expect(valueFor(result, 'raise', 'all_contesting_opponents_call')).toMatchObject({
      amount: 8,
      committed: 8,
      netChips: 6,
      worstNetChips: -8,
      bestNetChips: 48,
      refund: 0,
    });
    expect(valueFor(result, 'raise', 'all_contesting_opponents_fold')).toMatchObject({
      amount: 8,
      committed: 8,
      netChips: 44,
      refund: 4,
    });
    expect(result.best).toEqual({
      action: 'raise',
      response: 'all_contesting_opponents_fold',
    });
    expect(remainingVariantActionEconomicsIsValid(result)).toBe(true);
  });

  it('moves with the terminal scores rather than counting samples', () => {
    const loseAll = remainingVariantActionEconomics(
      flhHeadsUp({ samples: Array.from({ length: 4 }, () => showdown(1, [9])) })
    );
    const winAll = remainingVariantActionEconomics(
      flhHeadsUp({ samples: Array.from({ length: 4 }, () => showdown(9, [1])) })
    );
    const chopAll = remainingVariantActionEconomics(
      flhHeadsUp({ samples: Array.from({ length: 4 }, () => showdown(5, [5])) })
    );
    // Losing every showdown: hero is out his 4 call and nothing else.
    expect(valueFor(loseAll, 'call', 'terminal_showdown')!.netChips).toBe(-4);
    // Winning every showdown: 48 - 4.
    expect(valueFor(winAll, 'call', 'terminal_showdown')!.netChips).toBe(44);
    // Chopping 48 two ways: 24 - 4.
    expect(valueFor(chopAll, 'call', 'terminal_showdown')!.netChips).toBe(20);
    // Losing every showdown never touches the line where everybody folds:
    // that one wins the 48 pot on the wager alone, so it stays the argmax and
    // folding is only ever better than CALLING.
    expect(loseAll.best).toEqual({
      action: 'raise',
      response: 'all_contesting_opponents_fold',
    });
    expect(valueFor(loseAll, 'call', 'terminal_showdown')!.netChips).toBeLessThan(
      valueFor(loseAll, 'fold', 'terminal_showdown')!.netChips
    );
  });

  it('leaves every input object exactly as the caller passed it', () => {
    const input = flhHeadsUp({ samples: oneWinInFour });
    const before = structuredClone({
      hero: input.hero,
      players: input.players,
      samples: input.samples,
      actionHistory: input.actionHistory,
    });
    remainingVariantActionEconomics(input);
    expect({
      hero: input.hero,
      players: input.players,
      samples: input.samples,
      actionHistory: input.actionHistory,
    }).toEqual(before);
  });
});

describe('P12.1 charges the configured deductions, not an estimate of them', () => {
  const winAll = Array.from({ length: 4 }, () => showdown(9, [1]));

  it('takes the percentage rake the schedule actually configures', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({ samples: winAll, rakeConfig: FIVE_PERCENT })
    );
    // Heads-up pots pay at most 5% (HEADS_UP_RAKE_PERCENT): 48 * 5% = 2.40,
    // under the 10 cap, so hero takes 45.60 and nets 45.60 - 4 = 41.60.
    const call = valueFor(result, 'call', 'terminal_showdown')!;
    expect(call.rake).toBeCloseTo(2.4, 6);
    expect(call.netChips).toBeCloseTo(41.6, 6);
  });

  it('stops at the configured cap instead of scaling past it', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({ samples: winAll, rakeConfig: { percent: 5, cap: 1, noFlopNoDrop: true } })
    );
    // 48 * 5% = 2.40 but the cap is 1.00, so exactly 1.00 is taken.
    const call = valueFor(result, 'call', 'terminal_showdown')!;
    expect(call.rake).toBe(1);
    expect(call.netChips).toBeCloseTo(43, 6);
  });

  it('prices the BBJ fee through the joint deduction owner', () => {
    const bbj: HandConfig['bbjConfig'] = {
      enabled: true,
      feeBB: 0.25,
      minPotBB: 0,
      minPlayersDealt: 2,
    };
    const withFee = remainingVariantActionEconomics(
      flhHeadsUp({ samples: winAll, bbjConfig: bbj })
    );
    const withoutFee = remainingVariantActionEconomics(
      flhHeadsUp({ samples: winAll, bbjConfig: { ...bbj, enabled: false } })
    );
    // 0.25 BB of a 2 big blind is 0.50 per qualifying hand.
    expect(valueFor(withFee, 'call', 'terminal_showdown')!.bbjFee).toBeCloseTo(0.5, 6);
    expect(valueFor(withoutFee, 'call', 'terminal_showdown')!.bbjFee).toBe(0);
    expect(valueFor(withFee, 'call', 'terminal_showdown')!.netChips).toBeCloseTo(
      valueFor(withoutFee, 'call', 'terminal_showdown')!.netChips - 0.5,
      6
    );
  });

  it('refuses a fee schedule the deduction owner rejects rather than guessing one', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({
        samples: winAll,
        rakeConfig: { percent: 5, cap: 10, noFlopNoDrop: true, timedRake: { amountPerMinute: 1 } },
      })
    );
    expect(result.values).toEqual([]);
    expect(result.unavailable).toBe('terminal_settlement_unavailable');
    expect(remainingVariantActionEconomicsIsValid(result)).toBe(true);
  });

  it('settles a tournament node in whole units', () => {
    const players = [seat('hero', 1, 1000, 0, 200), seat('v3', 2, 1000, 40, 240)];
    const result = remainingVariantActionEconomics(
      flhHeadsUp({
        players,
        hero: players[0],
        samples: winAll,
        currentBet: 40,
        betSize: 40,
        minRaiseTo: 80,
        maxRaiseTo: 80,
        actionHistory: [
          {
            userId: 'v3',
            seat: 2,
            action: 'bet',
            amount: 40,
            stage: 'river',
            timestamp: 1,
            isFullRaise: true,
          },
        ],
        chipUnit: 1,
        gameMode: 'tournament',
        bigBlind: 20,
        rakeConfig: NO_RAKE,
      })
    );
    // Pot 480 after the call, no fees in a tournament: 480 - 40 = 440.
    const call = valueFor(result, 'call', 'terminal_showdown')!;
    expect(call.netChips).toBe(440);
    expect(Number.isInteger(call.netChips)).toBe(true);
    expect(result.chipUnit).toBe(1);
  });
});

describe('P12.1 reads individual pot eligibility and the uncalled-bet refund', () => {
  /** FLH three-handed river. v4 is all in short for 10 total; v3 has 24 in and
   * bets 4; hero has 20 in. Main pot 10 x 3 = 30, side pot 2 x (24 - 10) = 28
   * once hero calls to 24. */
  function flhShortAllIn(samples: HorseEquityOutcomeSample[]) {
    const players = [
      seat('hero', 1, 100, 0, 20),
      seat('v3', 2, 100, 4, 24),
      seat('v4', 3, 0, 0, 10, { is_all_in: true }),
    ];
    return remainingVariantActionEconomics(
      flhHeadsUp({
        players,
        hero: players[0],
        opponentIds: ['v3', 'v4'],
        samples,
      })
    );
  }

  it('awards the side pot alone when the short seat wins the main', () => {
    // Hero beats v3 and loses to the all-in v4. v4 takes the 30 main pot; the
    // 28 side pot is contested only by hero and v3, and hero wins it. Hero's
    // return is NOT a fraction of the 58 in the middle: it is one whole pot
    // he is eligible for and none of the one he is not.
    const result = flhShortAllIn(Array.from({ length: 4 }, () => showdown(5, [1, 9])));
    const call = valueFor(result, 'call', 'terminal_showdown')!;
    expect(call.netChips).toBe(24); // 28 - 4
    expect(call.refund).toBe(0);
  });

  it('awards both pots when hero beats every seat he is eligible against', () => {
    const result = flhShortAllIn(Array.from({ length: 4 }, () => showdown(9, [1, 5])));
    // 30 + 28 = 58 won, 4 committed.
    expect(valueFor(result, 'call', 'terminal_showdown')!.netChips).toBe(54);
  });

  it('awards nothing when the covering seat wins both pots', () => {
    const result = flhShortAllIn(Array.from({ length: 4 }, () => showdown(5, [9, 1])));
    expect(valueFor(result, 'call', 'terminal_showdown')!.netChips).toBe(-4);
  });

  it('returns the uncalled part of a wager a short seat cannot cover', () => {
    // Hero raises to 8 while v3 calls and v4 is already all in: no excess.
    const covered = flhShortAllIn(Array.from({ length: 4 }, () => showdown(9, [1, 1])));
    expect(valueFor(covered, 'raise', 'all_contesting_opponents_call')!.refund).toBe(0);
    // Now v3 can only put in 2 more, so 2 of hero's raise is uncalled.
    const players = [
      seat('hero', 1, 100, 0, 20),
      seat('v3', 2, 2, 4, 24),
      seat('v4', 3, 0, 0, 10, { is_all_in: true }),
    ];
    const short = remainingVariantActionEconomics(
      flhHeadsUp({
        players,
        hero: players[0],
        opponentIds: ['v3', 'v4'],
        samples: Array.from({ length: 4 }, () => showdown(9, [1, 1])),
      })
    );
    const raise = valueFor(short, 'raise', 'all_contesting_opponents_call')!;
    // Hero commits 8 to 28 total; v3 reaches 26; 2 comes straight back.
    expect(raise.refund).toBe(2);
    // Pots: 10 x 3 = 30 main, then (26 - 10) x 2 = 32: hero wins both, 62.
    // 62 + 2 - 8 = 56.
    expect(raise.netChips).toBe(56);
  });
});

describe('P12.1 applies the game-specific split, not one scoring model', () => {
  /** FLO8 three-handed river, every seat at 24 after hero calls 4. Pot 72. */
  function flo8Spot(samples: HorseEquityOutcomeSample[], rakeConfig = NO_RAKE) {
    const players = [
      seat('hero', 1, 100, 0, 20),
      seat('v3', 2, 100, 4, 24),
      seat('v4', 3, 100, 4, 24),
    ];
    return remainingVariantActionEconomics(
      flhHeadsUp({
        variant: 'flo8',
        players,
        hero: players[0],
        opponentIds: ['v3', 'v4'],
        samples,
        rakeConfig,
      })
    );
  }

  it('quarters a tied low while another seat takes the high', () => {
    // High 36 to v4; low 36 split between hero and v3, so hero takes 18.
    const result = flo8Spot(Array.from({ length: 4 }, () => showdown(1, [1, 9], 1, [1, null])));
    expect(result.scoring).toBe('high_low_split');
    expect(valueFor(result, 'call', 'terminal_showdown')!.netChips).toBe(14); // 18 - 4
  });

  it('scoops when it wins both halves', () => {
    const result = flo8Spot(Array.from({ length: 4 }, () => showdown(9, [1, 1], 1, [5, null])));
    // Whole 72 to hero: 72 - 4 = 68.
    expect(valueFor(result, 'call', 'terminal_showdown')!.netChips).toBe(68);
  });

  it('pays the high the whole pot when no hand qualifies low', () => {
    const result = flo8Spot(Array.from({ length: 4 }, () => showdown(9, [1, 1])));
    expect(valueFor(result, 'call', 'terminal_showdown')!.netChips).toBe(68);
  });

  it('charges rake on the quartered award the winners actually take', () => {
    const result = flo8Spot(
      Array.from({ length: 4 }, () => showdown(1, [1, 9], 1, [1, null])),
      FIVE_PERCENT
    );
    // Three-handed, so 5% of 72 is 3.60 under the 10 cap. The owner scales the
    // three winning entitlements 36 / 18 / 18 to 68.40, giving hero 17.10.
    const call = valueFor(result, 'call', 'terminal_showdown')!;
    expect(call.rake).toBeCloseTo(3.6, 6);
    expect(call.netChips).toBeCloseTo(13.1, 6); // 17.10 - 4
  });

  it('refuses a qualifying low offered for a high-only game', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({ samples: Array.from({ length: 4 }, () => showdown(9, [1], 1, [5])) })
    );
    expect(result.unavailable).toBe('terminal_samples_rejected');
    expect(result.values).toEqual([]);
  });
});

describe('P12.1 takes its wager bound from the controller, never from itself', () => {
  it('completes a short level to the full street bet', () => {
    // v4 is all in for 1 on a 4 bet street. 1 is under half of 4, so it never
    // counted as a wager (WSOP 2026 rule 133): the street's first full wager
    // level is still 4, and hero COMPLETES it by adding 3 on top of the 1.
    const players = [
      seat('hero', 1, 100, 0, 20),
      seat('v4', 3, 0, 1, 21, { is_all_in: true }),
      seat('v3', 2, 100, 0, 20),
    ];
    const result = remainingVariantActionEconomics(
      flhHeadsUp({
        players,
        hero: players[0],
        opponentIds: ['v4', 'v3'],
        samples: Array.from({ length: 4 }, () => showdown(9, [1, 1])),
        currentBet: 1,
        minRaiseTo: 4,
        maxRaiseTo: 4,
        actionHistory: [
          { userId: 'v4', seat: 3, action: 'all_in', amount: 1, stage: 'river', timestamp: 1 },
        ],
      })
    );
    expect(result.wagerBounds).toMatchObject({
      betSize: 4,
      raiseSize: 3,
      raiseTo: 4,
      wagers: 0,
      completion: true,
      capped: false,
    });
    expect(valueFor(result, 'raise', 'all_contesting_opponents_call')!.amount).toBe(4);
    expect(remainingVariantActionEconomicsIsValid(result)).toBe(true);
  });

  it('refuses the node when its derived bound and the controller disagree', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({
        samples: Array.from({ length: 4 }, () => showdown(9, [1])),
        minRaiseTo: 12,
        maxRaiseTo: 12,
      })
    );
    expect(result.unavailable).toBe('wager_bounds_unavailable');
    expect(result.values).toEqual([]);
    expect(remainingVariantActionEconomicsIsValid(result)).toBe(true);
  });

  it('prices no wager on a capped street and still prices the call', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({
        samples: Array.from({ length: 4 }, () => showdown(9, [1])),
        legalActions: ['fold', 'call'],
        wagersCapped: true,
        minRaiseTo: null,
        maxRaiseTo: null,
      })
    );
    expect(result.unavailable).toBe(null);
    expect(result.wagerBounds).toMatchObject({ capped: true });
    expect(result.values.some((v) => v.action === 'raise')).toBe(false);
    expect(valueFor(result, 'call', 'terminal_showdown')!.netChips).toBe(44);
    expect(remainingVariantActionEconomicsIsValid(result)).toBe(true);
  });

  it('prices the completion the real controller then accepts', () => {
    // A real FLH 20/40 hand. v4 covers the 20 preflop bet and has 5 behind,
    // so his river all in is 5 against a 40 big bet: a short level hero
    // COMPLETES. The amount priced here must be the amount the controller
    // takes, or the receipt is describing a line nobody can play.
    const hc = new HandController(
      {
        tableId: 'p12-net-action-completion',
        handNumber: 1,
        gameVariant: 'flh',
        smallBlind: 10,
        bigBlind: 20,
        rakeConfig: NO_RAKE,
      },
      [seat('hero', 1, 500, 0, 0), seat('v3', 2, 500, 0, 0), seat('v4', 3, 25, 0, 0)],
      1
    );
    hc.start();
    const act = (expectSeat: number, action: 'call' | 'check' | 'all_in') => {
      expect(hc.getState().currentPlayerSeat).toBe(expectSeat);
      expect(hc.performAction(expectSeat, action)).toBe(true);
    };
    act(1, 'call');
    act(2, 'call');
    act(3, 'check');
    for (const stage of ['flop', 'turn'] as const) {
      expect(hc.getState().stage).toBe(stage);
      act(2, 'check');
      act(3, 'check');
      act(1, 'check');
    }
    expect(hc.getState().stage).toBe('river');
    act(2, 'check');
    act(3, 'all_in');
    const actual = hc.getState();
    expect(actual.currentPlayerSeat).toBe(1);
    expect(actual.currentBet).toBe(5);
    const heroSeat = actual.players.find((p) => p.user_id === 'hero')!;
    const bounds = hc.getAuthoritativeActionState('hero')!;
    expect(bounds.fixedBetSize).toBe(40);
    const opponentIds = actual.players
      .filter((p) => p.user_id !== 'hero' && !p.is_folded)
      .map((p) => p.user_id);
    const result = remainingVariantActionEconomics({
      variant: 'flh',
      stage: 'river',
      hero: { ...heroSeat, cards: [] },
      players: actual.players.map((p) => ({ ...p, cards: [] })),
      opponentIds,
      samples: Array.from({ length: 4 }, () =>
        showdown(
          9,
          opponentIds.map(() => 1)
        )
      ),
      currentBet: actual.currentBet,
      betSize: bounds.fixedBetSize!,
      actionHistory: actual.actionHistory ?? [],
      legalActions: bounds.legalActions,
      wagersCapped: bounds.wagersCapped ?? false,
      minRaiseTo: bounds.minRaiseTo ?? null,
      maxRaiseTo: bounds.maxRaiseTo ?? null,
      chipUnit: 0.01,
      asset: 'chips',
      gameMode: 'cash',
      bigBlind: 20,
      dealerSeat: actual.dealerSeat ?? 1,
      rakeConfig: hc.getRakeConfigSnapshot(),
      bbjConfig: null,
      now: () => 0,
    });
    expect(result.unavailable).toBe(null);
    // A 5 short level completes to the street's first full wager, 40, by
    // adding 35: raiseSize 35 under a 40 bet is the completion.
    expect(result.wagerBounds).toMatchObject({
      betSize: 40,
      raiseSize: 35,
      raiseTo: 40,
      completion: true,
      capped: false,
    });
    const wager = valueFor(result, 'raise', 'all_contesting_opponents_call')!;
    expect(wager.amount).toBe(bounds.minRaiseTo);
    expect(wager.amount).toBe(40);
    // THE EXECUTOR CONTRAST: the controller accepts exactly this amount.
    expect(hc.performAction(heroSeat.seat, 'raise', wager.amount!)).toBe(true);
    expect(hc.getState().currentBet).toBe(40);
  });
});

describe('P12.1 names every refusal', () => {
  const samples = Array.from({ length: 4 }, () => showdown(9, [1]));

  it.each([
    ['short_deck', 'variant_outside_net_action_slice'],
    ['pineapple', 'variant_outside_net_action_slice'],
    ['plo8', 'variant_outside_net_action_slice'],
    ['nlh', 'variant_outside_net_action_slice'],
  ])('refuses %s by name', (variant, reason) => {
    const result = remainingVariantActionEconomics(flhHeadsUp({ samples, variant }));
    expect(result.unavailable).toBe(reason);
    expect(result.values).toEqual([]);
  });

  it.each(['preflop', 'flop', 'turn', 'showdown', 'pineapple_discard'])(
    'refuses the %s node by name',
    (stage) => {
      const result = remainingVariantActionEconomics(flhHeadsUp({ samples, stage }));
      expect(result.unavailable).toBe('street_outside_net_action_slice');
    }
  );

  it('refuses a roster the samples were not scored against', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({ samples, opponentIds: ['someone_else'] })
    );
    expect(result.unavailable).toBe('contesting_roster_mismatch');
  });

  it.each([0, 1, MIN_TERMINAL_SAMPLES - 1])('refuses %s terminal samples', (count) => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({ samples: samples.slice(0, count) })
    );
    expect(result.unavailable).toBe('terminal_samples_unavailable');
  });

  it('refuses a sample whose opponent arrays do not match the roster', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({ samples: Array.from({ length: 4 }, () => showdown(9, [1, 1])) })
    );
    expect(result.unavailable).toBe('terminal_samples_rejected');
  });

  it.each([
    ['chipUnit', { chipUnit: 0.5 as unknown as 0.01 }, 'chip_unit_unavailable'],
    ['dealerSeat', { dealerSeat: 0 }, 'canonical_input_unavailable'],
    ['bigBlind', { bigBlind: 0 }, 'canonical_input_unavailable'],
    ['betSize', { betSize: 0 }, 'canonical_input_unavailable'],
    ['currentBet', { currentBet: Number.NaN }, 'canonical_input_unavailable'],
    ['gameMode', { gameMode: 'spin' as unknown as 'cash' }, 'canonical_input_unavailable'],
    ['asset', { asset: 'gold' as unknown as 'chips' }, 'canonical_input_unavailable'],
  ])('refuses a bad %s by name', (_label, override, reason) => {
    const result = remainingVariantActionEconomics(flhHeadsUp({ samples, ...override }));
    expect(result.unavailable).toBe(reason);
    expect(result.values).toEqual([]);
    expect(remainingVariantActionEconomicsIsValid(result)).toBe(true);
  });

  it('reports an exhausted budget rather than averaging a partial line', () => {
    let calls = 0;
    const result = remainingVariantActionEconomics(
      flhHeadsUp({
        samples: Array.from({ length: 16 }, () => showdown(9, [1])),
        withinBudget: () => ++calls <= 2,
      })
    );
    expect(result.unavailable).toBe('work_budget_unavailable');
    expect(result.budgetExhausted).toBe(true);
    expect(result.values).toEqual([]);
    expect(remainingVariantActionEconomicsIsValid(result)).toBe(true);
  });

  it('completes every line when the budget holds', () => {
    const result = remainingVariantActionEconomics(
      flhHeadsUp({ samples: Array.from({ length: 16 }, () => showdown(9, [1])) })
    );
    expect(result.budgetExhausted).toBe(false);
    expect(result.values.every((v) => v.samples === 16 || v.action !== 'call')).toBe(true);
  });
});

describe('P12.1 receipt validation actually rejects a wrong receipt', () => {
  const build = () =>
    remainingVariantActionEconomics(
      flhHeadsUp({ samples: Array.from({ length: 4 }, () => showdown(9, [1])) })
    );

  it('accepts the receipt the module just produced', () => {
    expect(remainingVariantActionEconomicsIsValid(structuredClone(build()))).toBe(true);
  });

  it.each([
    ['a different version', (r: Record<string, unknown>) => (r.version = 'v2')],
    ['an unlisted variant', (r: Record<string, unknown>) => (r.variant = 'plo8')],
    ['the wrong scoring model', (r: Record<string, unknown>) => (r.scoring = 'high_low_split')],
    ['another street', (r: Record<string, unknown>) => (r.street = 'turn')],
    ['a refusal alongside values', (r: Record<string, unknown>) => (r.unavailable = 'off')],
    ['an unnamed refusal', (r: Record<string, unknown>) => ((r.values = []), (r.best = null))],
    ['an extra key', (r: Record<string, unknown>) => (r.extra = 1)],
    ['a missing key', (r: Record<string, unknown>) => delete r.chipUnit],
    ['a shifted chip unit', (r: Record<string, unknown>) => (r.chipUnit = 0.5)],
    ['a negative latency', (r: Record<string, unknown>) => (r.analysisMs = -1)],
    [
      'a best that is not the argmax',
      (r: Record<string, unknown>) => (r.best = { action: 'fold', response: 'terminal_showdown' }),
    ],
    [
      'a best naming an unlisted response',
      (r: Record<string, unknown>) => (r.best = { action: 'call', response: 'nope' }),
    ],
    [
      'a fold that claims chips',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'fold')!.netChips = 5),
    ],
    [
      'a fold that committed chips',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'fold')!.committed = 4),
    ],
    [
      'a wager off its declared bound',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'raise')!.amount = 9),
    ],
    ['a wager with no declared bound', (r: Record<string, unknown>) => (r.wagerBounds = null)],
    [
      'bounds whose completion flag contradicts the size',
      (r: Record<string, unknown>) =>
        ((r.wagerBounds as Record<string, unknown>).completion = true),
    ],
    [
      'bounds with more wagers than a street allows',
      (r: Record<string, unknown>) => ((r.wagerBounds as Record<string, unknown>).wagers = 5),
    ],
    [
      'a worst above the mean',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'call')!.worstNetChips =
          1000),
    ],
    [
      'a best below the mean',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'call')!.bestNetChips =
          -1000),
    ],
    [
      'negative rake',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'call')!.rake = -1),
    ],
    [
      'a line below the sample floor',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'call')!.samples = 1),
    ],
    [
      'a duplicated line',
      (r: Record<string, unknown>) =>
        (r.values as Record<string, unknown>[]).push(
          structuredClone((r.values as Record<string, unknown>[])[1])
        ),
    ],
    [
      'a call priced on a response assumption',
      (r: Record<string, unknown>) =>
        ((r.values as Record<string, unknown>[]).find((v) => v.action === 'call')!.response =
          'all_contesting_opponents_call'),
    ],
    [
      'an extra key inside a line',
      (r: Record<string, unknown>) => ((r.values as Record<string, unknown>[])[0].surprise = true),
    ],
  ])('rejects %s', (_label, mutate) => {
    const receipt = structuredClone(build()) as unknown as Record<string, unknown>;
    expect(remainingVariantActionEconomicsIsValid(receipt)).toBe(true);
    mutate(receipt);
    expect(remainingVariantActionEconomicsIsValid(receipt)).toBe(false);
  });

  it.each([null, undefined, 0, '', [], 'receipt'])('rejects %s outright', (value) => {
    expect(remainingVariantActionEconomicsIsValid(value)).toBe(false);
  });
});
