import { afterEach, describe, expect, it, vi } from 'vitest';
import * as CallDeductions from './HorseCallDeductions.js';
import * as Eval from './HorseEval.js';
import * as Ev from './HorseEvEngine.js';
import { HorseMind } from './HorseMind.js';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import { horseCallDeductionFraction } from './HorseCallDeductions.js';
import { snapshotDiamondCashFees } from '../domain/diamondCashFeeSnapshot.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { barrelContinuationValue } from './HorseContinuation.js';
import type { SeatPlayer } from '../types.js';
function seat(n: number, invested: number, stack = 100): SeatPlayer {
  return {
    seat: n,
    user_id: `u${n}`,
    username: 'offline',
    totalInvested: invested,
    bet: invested,
    stack,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  } as SeatPlayer;
}
function spot() {
  const hero = seat(1, 10);
  const gs = {
    stateSchemaVersion: 1,
    gameMode: 'cash',
    gameVariant: 'nlh',
    asset: 'chips',
    chipUnit: 0.01,
    players: [hero, seat(2, 20)],
    pot: 30,
    bigBlind: 2,
    rakeConfig: { percent: 10, cap: 2.5, noFlopNoDrop: true },
    stage: 'turn',
  } as HorseGameStateV2;
  return { hero, gs };
}
describe('call pricing subtracts actual capped deductions', () => {
  it('a reached cap is still removed from the award, although marginal rake is zero', () => {
    const { hero, gs } = spot();
    const fraction = horseCallDeductionFraction(hero, gs, 10)!;
    expect(fraction).toBe(2 / 40); // heads-up 5% ceiling
    gs.rakeConfig!.cap = 1;
    expect(horseCallDeductionFraction(hero, gs, 10)).toBe(1 / 40);
    expect(HorseLogic.__testables.rakeDrag(40, 2, gs.rakeConfig, 2)).toBe(0);
  });
  it('prices the matched pot after returning an uncallable overbet', () => {
    const hero = seat(1, 50, 50),
      other = seat(2, 500, 0);
    const gs = { ...spot().gs, players: [hero, other], pot: 550 };
    expect(horseCallDeductionFraction(hero, gs, 500)).toBe(2.5 / 200);
  });
  it('uses the global deduction fraction for main and side-pot awards', () => {
    const hero = seat(1, 50, 50),
      other = seat(2, 1000, 0),
      third = seat(3, 1000, 0);
    const gs = { ...spot().gs, players: [hero, other, third], pot: 2050 };
    expect(horseCallDeductionFraction(hero, gs, 950)).toBe(2.5 / 2100);
  });
  it('includes the flop BBJ collection even below the jackpot award threshold', () => {
    const { hero, gs } = spot();
    gs.players.push({ ...seat(3, 0), is_folded: true });
    gs.bbjConfig = { enabled: true, feeBB: 0.1, minPlayersDealt: 3, minPotBB: 100 };
    expect(horseCallDeductionFraction(hero, gs, 10)).toBe((2.5 + 0.2) / 40);
  });
  it('keeps tournaments free of per-pot rake and refuses incomplete snapshot pricing', () => {
    const { hero, gs } = spot();
    expect(horseCallDeductionFraction(hero, { ...gs, gameMode: 'tournament' }, 10)).toBe(0);
    expect(
      horseCallDeductionFraction(hero, { ...gs, stateSchemaVersion: undefined }, 10)
    ).toBeNull();
    expect(horseCallDeductionFraction(hero, { ...gs, pot: 300 }, 10)).toBeNull();
  });
  it('uses the frozen whole-Diamond schedule rather than zero chip-rake columns', () => {
    const { hero, gs } = spot();
    gs.asset = 'diamonds';
    gs.chipUnit = 1;
    const exact = (n: bigint) => ({ units: n, scale: 0 });
    const schedule = snapshotDiamondCashFees({
      enabled: true,
      bigBlind: 2,
      noFlopNoDrop: true,
      rounding: 'down',
      minPot: exact(0n),
      percent: { _heads_up: exact(5n), _three_handed: exact(10n), '': exact(10n) },
      cap: { _heads_up: exact(1n), _three_handed: exact(3n), '': exact(5n) },
    });
    gs.rakeConfig = {
      percent: 0,
      cap: 0,
      noFlopNoDrop: true,
      diamondCashFees: { schedule, variant: 'nlh', doubleBoard: false },
    };
    expect(horseCallDeductionFraction(hero, gs, 10)).toBe(1 / 40);
  });
  it('does not mutate the live contribution snapshot', () => {
    const { hero, gs } = spot();
    const before = structuredClone(gs);
    horseCallDeductionFraction(hero, gs, 10);
    expect(gs).toEqual(before);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('the final brain receives projected call deductions', () => {
  it('passes capped net-award pricing into the existing EV consumer', () => {
    const { hero, gs } = spot();
    hero.cards = [
      { rank: '8', suit: 'hearts' },
      { rank: '8', suit: 'diamonds' },
    ];
    gs.communityCards = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'diamonds' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'spades' },
      { rank: '3', suit: 'diamonds' },
    ];
    gs.stage = 'river';
    gs.currentBet = 20;
    gs.toCall = 10;
    gs.minRaise = 10;
    gs.minRaiseTo = 30;
    gs.maxRaiseTo = 110;
    gs.dealerSeat = 2;
    gs.legalActions = ['fold', 'call', 'raise', 'all_in'];
    gs.rakeConfig!.cap = 1;
    gs.actionHistory = [
      { seat: 2, userId: 'u2', action: 'bet', amount: 20, stage: 'river', timestamp: 1 },
    ];
    const pricing = vi.spyOn(CallDeductions, 'horseCallDeductionFraction');
    const ev = vi.spyOn(Ev, 'riverCallVerdict');
    const simulate = Eval.simulateEquity;
    vi.spyOn(Eval, 'simulateEquity').mockImplementation((...args) => {
      simulate(...args);
      return 0.25;
    });
    Eval.seedFastRandom(2601026);
    HorseLogic.decide(
      hero,
      gs,
      'balanced',
      {},
      { mind: false, telemetry: false, v32FacingDefense: false }
    );
    expect(pricing).toHaveBeenCalledWith(hero, gs, 10);
    expect(ev.mock.calls.at(-1)?.[0].callDeductionFraction).toBeCloseTo(1 / 40, 10);
    expect(ev.mock.calls.at(-1)?.[0].rakeMarg).toBe(0);
  });
  it('keeps the terminal-flop bet consumer on marginal rake after the cap', () => {
    const { hero, gs } = spot();
    hero.cards = [
      { rank: '8', suit: 'hearts' },
      { rank: '8', suit: 'diamonds' },
    ];
    hero.stack = 5;
    hero.bet = 0;
    hero.totalInvested = 15;
    Object.assign(gs.players[1], { stack: 5, bet: 0, totalInvested: 15 });
    Object.assign(gs, {
      stage: 'flop',
      currentBet: 0,
      toCall: 0,
      minRaise: 2,
      communityCards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'diamonds' },
        { rank: '7', suit: 'clubs' },
      ],
      actionHistory: [
        { seat: 1, userId: 'u1', action: 'raise', amount: 15, stage: 'preflop', timestamp: 1 },
        { seat: 2, userId: 'u2', action: 'call', amount: 15, stage: 'preflop', timestamp: 2 },
      ],
    });
    gs.rakeConfig!.cap = 1;
    const ev = vi.spyOn(Ev, 'evaluateSpot');
    Eval.seedFastRandom(2601026);
    HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, telemetry: false });
    const terminal = ev.mock.calls.find(([s]) => s.toCall === 0 && s.sizes?.length === 0)?.[0];
    expect(terminal).toBeDefined();
    expect(terminal!.rakeMarg).toBe(0);
  });
});

describe('exact call deductions are distinct from marginal bet rake', () => {
  it('retains a reached fee cap as the continuation pot grows', () => {
    expect(
      barrelContinuationValue({
        equity: 1,
        pot: 30,
        toCall: 10,
        stack: 30,
        continuation: { betProbability: 1, betFraction: 1, opponentStack: 20, streets: 1 },
        rakeMarg: 0,
        callDeductionFraction: 1 / 40,
      })
    ).toBe(49);
  });
  it('does not clamp a true call deduction above fifty percent', () => {
    const result = Ev.riverCallVerdict({
      equity: 1,
      pot: 10,
      toCall: 4,
      stack: 4,
      rakeMarg: 0,
      callDeductionFraction: 0.8,
      rand: () => 0,
    });
    expect(result.call).toBe(false);
    expect(result.evCall).toBeCloseTo(-1.2, 10);
    const verdict = Ev.evaluateSpot({
      equity: 1,
      pot: 10,
      toCall: 4,
      stack: 4,
      effectiveStack: 4,
      street: 'river',
      inPosition: true,
      opponents: 1,
      realization: 1,
      rakeMarg: 0,
      callDeductionFraction: 0.8,
      minBet: 1,
      maxBet: 0,
      sizes: [],
      rand: () => 0,
    });
    expect(verdict.candidates.find((a) => a.kind === 'call')!.ev).toBeCloseTo(-1.2, 10);
  });
  it('never mixes into a priced call when the entire award is deducted', () => {
    const result = Ev.riverCallVerdict({
      equity: 1,
      pot: 10,
      toCall: 4,
      stack: 4,
      callDeductionFraction: 1,
      rand: () => 0,
    });
    expect(result.call).toBe(false);
    expect(result.evCall).toBe(-4);
  });
  it('recognizes the actual BBJ collection consuming a tiny matched award', () => {
    const hero = seat(1, 0, 0.01);
    const gs = {
      ...spot().gs,
      players: [hero, seat(2, 0.01, 0), seat(3, 0.01, 0)],
      pot: 0.02,
      dealtSeatIds: [1, 2, 3],
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      bbjConfig: { enabled: true, feeBB: 0.1, minPlayersDealt: 3, minPotBB: 0 },
    };
    const fraction = horseCallDeductionFraction(hero, gs, 0.01)!;
    expect(fraction).toBe(1);
    expect(
      Ev.riverCallVerdict({
        equity: 1,
        pot: 0.02,
        toCall: 0.01,
        stack: 0.01,
        callDeductionFraction: fraction,
        rand: () => 0,
      }).call
    ).toBe(false);
  });
});

describe('preflop price-in guards use net cash awards', () => {
  it('does not rescue a fold using an artificially cheap gross-pot price', () => {
    const ctx: PreflopCtx = {
      strength: 0,
      position: 'early',
      raiserPosition: 'early',
      raises: 2,
      limpers: 0,
      callers: 1,
      oppsLeft: 2,
      toCall: 10,
      currentBet: 10,
      pot: 57,
      bigBlind: 2,
      stack: 100,
      stackBB: 50,
      tightness: 1,
      bluffFreq: 0,
      aggression: 1,
      slowplayFreq: 0,
      sizingMultiplier: 1,
      isOmaha: false,
      isPotLimit: false,
      riskAdd: 0,
      mode: 'cash',
      tableSize: 3,
      rand: () => 0.5,
    };
    expect(decidePreflopV7(ctx).a).toBe('call');
    expect(decidePreflopV7({ ...ctx, callDeductionFraction: 0.1 }).a).toBe('fold');
    expect(decidePreflopV7({ ...ctx, mode: 'tournament', callDeductionFraction: 0.1 }).a).toBe(
      decidePreflopV7({ ...ctx, mode: 'tournament' }).a
    );
  });
});
