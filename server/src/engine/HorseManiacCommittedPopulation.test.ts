import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import * as Eval from './HorseEval.js';
import type { OpponentExploitRead } from './HorseOpponentExploit.js';
import type { SeatPlayer } from '../types.js';

const seat = (seat: number, over: Partial<SeatPlayer> = {}): SeatPlayer => ({
  seat,
  user_id: `seat-${seat}`,
  username: `seat-${seat}`,
  stack: 200,
  bet: 0,
  totalInvested: 0,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  is_horse: true,
  ...over,
});
function spot(extra: Partial<SeatPlayer> = {}) {
  const hero = seat(1, {
    cards: [
      { rank: 'J', suit: 'hearts' },
      { rank: '8', suit: 'hearts' },
    ],
  });
  const gs = {
    stateSchemaVersion: 1,
    asset: 'chips',
    chipUnit: 0.01,
    players: [
      { ...hero, cards: [] },
      seat(2, { stack: 0, bet: 200, totalInvested: 200, is_all_in: true }),
      seat(3, extra),
    ],
    dealtSeatIds: [1, 2, 3],
    communityCards: [],
    gameVariant: 'nlh',
    stage: 'preflop',
    gameMode: 'cash',
    currentBet: 200,
    bigBlind: 2,
    minRaise: 198,
    pot: 200 + (extra.totalInvested ?? 0),
    actionHistory: [
      {
        seat: 2,
        userId: 'seat-2',
        stage: 'preflop',
        action: 'all_in',
        amount: 200,
        isFullRaise: true,
        timestamp: 1,
      },
    ],
    rakeConfig: { percent: 5, cap: 6, noFlopNoDrop: true },
  } as HorseGameStateV2;
  return { hero, gs };
}
function decide(extra: Partial<SeatPlayer> = {}) {
  const { hero, gs } = spot(extra);
  return HorseLogic.__testables.maniacCallDown(
    { action: 'fold', thinkTime: 0 },
    hero,
    gs,
    Eval.variantInfo('nlh'),
    {}
  );
}
beforeEach(() => {
  const base = { engaged: null, mean: 0.2, excess: 0, lower: 0, upper: 1 };
  const stats = Object.fromEntries(
    ['vpip', 'pfr', 'rfi', 'threeBet', 'foldTo3Bet', 'betCheckedTo', 'foldToBet', 'riverCall'].map(
      (k) => [k, { ...base, ...(k === 'pfr' ? { engaged: 'high', mean: 1 } : {}) }]
    )
  );
  vi.spyOn(HorseMind, 'opponentRead').mockReturnValue({ stats } as unknown as OpponentExploitRead);
  vi.spyOn(HorseMind, 'bandFor').mockReturnValue([0, 1]);
  vi.spyOn(Eval, 'equitySampleSizeOfLastCall').mockReturnValue(360);
});
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

describe('preflop maniac recovery uses the actual committed population', () => {
  it('does not price unanswered seats as callers, but retains a real second caller', () => {
    const eq = vi
      .spyOn(Eval, 'simulateEquity')
      .mockImplementation((_hole, _board, opponents) => (opponents === 1 ? 0.58 : 0.29));
    expect(decide().action).toBe('all_in');
    expect(eq.mock.calls[0][2]).toBe(1);
    eq.mockClear();
    expect(
      decide({ stack: 0, bet: 200, totalInvested: 200, is_all_in: true, is_sitting_out: true })
        .action
    ).toBe('fold');
    expect(eq.mock.calls[0][2]).toBe(2);
  });
  it('includes a matched live caller without requiring it to be all in', () => {
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValue(0.29);
    expect(decide({ stack: 100, bet: 200, totalInvested: 200 }).action).toBe('fold');
    expect(eq.mock.calls[0][2]).toBe(2);
  });
  it('retains a noisy heads-up all-in refusal at the original governed budget', () => {
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValueOnce(0.48).mockReturnValue(0.58);
    expect(decide().action).toBe('fold');
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq.mock.calls[0][4]).toBe(360);
    eq.mockReset().mockReturnValue(0.5);
    expect(decide().action).toBe('fold'); // 200 / (400 - 6), not gross 50%.
    expect(eq).toHaveBeenCalledTimes(1); // The raked price is not lowered or retried.
  });
});

describe('NLH recovery does not select extra samples after seeing a low estimate', () => {
  it.each([0.48, 0.505])('retains the original priced refusal at equity %s', (initial) => {
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValueOnce(initial).mockReturnValue(0.9);
    expect(decide().action).toBe('fold');
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq.mock.calls[0][4]).toBe(360);
  });
  it.each([undefined, ''])('uses the selected NLH capabilities with gameVariant %s', (tag) => {
    const { hero, gs } = spot({ is_folded: true });
    if (tag === undefined) delete (gs as Partial<HorseGameStateV2>).gameVariant;
    else gs.gameVariant = tag;
    const selected = Eval.variantInfo(tag as string);
    expect(selected).toMatchObject({
      holeCount: 2,
      isOmaha: false,
      isShortDeck: false,
      isFixedLimit: false,
      isPotLimit: false,
    });
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValueOnce(0.48).mockReturnValue(0.9);
    const run = () =>
      HorseLogic.__testables.maniacCallDown(
        { action: 'fold', thinkTime: 0 },
        hero,
        gs,
        selected,
        {}
      );
    expect(run().action).toBe('fold');
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq.mock.calls[0][4]).toBe(360);
    // A cold-read early return would falsely pass the negative assertion.
    // Prove this same default-tag path actually prices and admits a valid call.
    eq.mockReset().mockReturnValueOnce(0.58).mockReturnValue(0.01);
    expect(run().action).toBe('all_in');
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq.mock.calls[0][4]).toBe(360);
  });
  it('does not replace two selected low estimates with a favorable fresh mean', () => {
    const eq = vi
      .spyOn(Eval, 'simulateEquity')
      .mockReturnValueOnce(0.48)
      .mockReturnValueOnce(0.48)
      .mockReturnValue(0.9);
    expect(decide().action).toBe('fold');
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq.mock.calls[0][4]).toBe(360);
  });
  it('retains a justified above-price all-in without a second estimate', () => {
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValueOnce(0.58).mockReturnValue(0.01);
    expect(decide().action).toBe('all_in');
    expect(eq).toHaveBeenCalledTimes(1);
  });
  it('retains a justified cheap all-in at the actual contestable price', () => {
    const { hero, gs } = spot({ is_folded: true });
    gs.contestablePot = 1000;
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValueOnce(0.25).mockReturnValue(0.01);
    expect(
      HorseLogic.__testables.maniacCallDown(
        { action: 'fold', thinkTime: 0 },
        hero,
        gs,
        Eval.variantInfo('nlh'),
        {}
      ).action
    ).toBe('all_in');
    expect(eq).toHaveBeenCalledTimes(1);
  });
});

it('does not recover a non-all-in flat while another live seat still owes the raise', () => {
  const { hero, gs } = spot();
  hero.stack = 400;
  gs.players[0] = { ...hero, cards: [] };
  const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValue(0.9);
  expect(
    HorseLogic.__testables.maniacCallDown(
      { action: 'fold', thinkTime: 0 },
      hero,
      gs,
      Eval.variantInfo('nlh'),
      {}
    ).action
  ).toBe('fold');
  expect(eq).toHaveBeenCalledTimes(1);
  gs.players[2].is_folded = true;
  expect(
    HorseLogic.__testables.maniacCallDown(
      { action: 'fold', thinkTime: 0 },
      hero,
      gs,
      Eval.variantInfo('nlh'),
      {}
    ).action
  ).toBe('call');
});

it('a presumed aggressive prior cannot substitute for measured call-down evidence', () => {
  const { hero, gs } = spot({ is_folded: true });
  const read = HorseMind.opponentRead('seat-2')!;
  vi.mocked(HorseMind.opponentRead).mockReturnValue({ ...read, presumed: true });
  const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValue(0.9);
  expect(
    HorseLogic.__testables.maniacCallDown(
      { action: 'fold', thinkTime: 0 },
      hero,
      gs,
      Eval.variantInfo('nlh'),
      {}
    ).action
  ).toBe('fold');
  expect(eq).not.toHaveBeenCalled();
});

it.each(['plo4', 'plo5', 'plo6'])(
  'uses measured postflop evidence while %s preflop aggression is presumed',
  (variant) => {
    const { hero, gs } = spot({ is_folded: true });
    hero.cards = [
      ...hero.cards,
      { rank: 'A', suit: 'diamonds' },
      { rank: 'Q', suit: 'clubs' },
      { rank: '6', suit: 'hearts' },
      { rank: '5', suit: 'spades' },
    ].slice(0, Number(variant.at(-1))) as SeatPlayer['cards'];
    gs.gameVariant = variant;
    gs.stage = 'flop';
    gs.communityCards = [
      { rank: 'K', suit: 'clubs' },
      { rank: '7', suit: 'diamonds' },
      { rank: '2', suit: 'hearts' },
    ];
    gs.actionHistory = [
      { seat: 2, userId: 'seat-2', stage: 'flop', action: 'bet', amount: 200, timestamp: 1 },
    ];
    const read = HorseMind.opponentRead('seat-2')!;
    vi.mocked(HorseMind.opponentRead).mockReturnValue({
      ...read,
      presumed: true,
      stats: {
        ...read.stats,
        betCheckedTo: { ...read.stats.betCheckedTo, engaged: 'high', mean: 0.9 },
      },
    });
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValue(0.9);
    expect(
      HorseLogic.__testables.maniacCallDown(
        { action: 'fold', thinkTime: 0 },
        hero,
        gs,
        Eval.variantInfo(variant),
        {}
      ).action
    ).toBe('all_in');
    expect(eq).toHaveBeenCalledTimes(1);
  }
);

// Public price/board and shown own cards from50221666. Controlled read/equity,
// not a historical replay. Variant extensions exercise the same owner.
it.each(['plo4', 'plo5', 'plo6'])(
  '%s uses one fixed recovery estimate at a weak-pair stack price',
  (variant) => {
    const { hero, gs } = spot({ is_folded: true });
    hero.stack = 313.3;
    hero.cards = [
      { rank: 'A', suit: 'clubs' },
      { rank: 'A', suit: 'spades' },
      { rank: 'T', suit: 'diamonds' },
      { rank: '8', suit: 'hearts' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'diamonds' },
    ].slice(0, Number(variant.at(-1))) as SeatPlayer['cards'];
    gs.players[0] = { ...hero, cards: [] };
    gs.players[1] = { ...gs.players[1], stack: 500, bet: 365, is_all_in: false };
    gs.gameVariant = variant;
    gs.stage = 'flop';
    gs.currentBet = 365;
    gs.pot = 1094;
    gs.contestablePot = 1042.3;
    gs.communityCards = [
      { rank: '3', suit: 'spades' },
      { rank: 'J', suit: 'hearts' },
      { rank: 'K', suit: 'diamonds' },
    ];
    gs.actionHistory = [
      { seat: 2, userId: 'seat-2', stage: 'flop', action: 'bet', amount: 365, timestamp: 1 },
    ];
    const read = HorseMind.opponentRead('seat-2')!;
    vi.mocked(HorseMind.opponentRead).mockReturnValue({
      ...read,
      stats: {
        ...read.stats,
        betCheckedTo: { ...read.stats.betCheckedTo, engaged: 'high', mean: 1 },
      },
    });
    vi.mocked(Eval.equitySampleSizeOfLastCall).mockReturnValue(240);
    const eq = vi.spyOn(Eval, 'simulateEquity');
    const run = () =>
      HorseLogic.__testables.maniacCallDown(
        { action: 'fold', thinkTime: 0 },
        hero,
        gs,
        Eval.variantInfo(variant),
        { v10Rake: false }
      );
    eq.mockReturnValueOnce(0.225).mockReturnValue(0.9);
    expect(run().action).toBe('fold');
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq.mock.calls[0][4]).toBe(240);
    eq.mockReset().mockReturnValueOnce(0.3).mockReturnValue(0.01);
    expect(run().action).toBe('all_in');
    expect(eq).toHaveBeenCalledTimes(1);
    eq.mockReset().mockReturnValueOnce(0.05).mockReturnValue(0.9);
    expect(run().action).toBe('fold');
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq.mock.calls[0][0]).toEqual(hero.cards);
    expect(eq.mock.calls[0][1]).toEqual(gs.communityCards);
    expect(eq.mock.calls[0][2]).toBe(1);
    expect(gs.players.every((p) => p.cards.length === 0)).toBe(true);
    // Exercise the actual reference graph caller with its decision controlled,
    // so the regression isolates recovery rather than adding strategy deals.
    vi.spyOn(
      HorseLogic as unknown as { decidePostflop: () => { action: 'fold'; thinkTime: number } },
      'decidePostflop'
    ).mockReturnValue({ action: 'fold', thinkTime: 0 });
    eq.mockReset().mockReturnValueOnce(0.225).mockReturnValue(0.9);
    expect(
      HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        {
          v10Rake: false,
          phase13Joint: 'off',
          telemetry: false,
        }
      ).action
    ).toBe('fold');
    expect(eq).toHaveBeenCalledTimes(1);
  }
);
