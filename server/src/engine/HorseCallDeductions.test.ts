import { afterEach, describe, expect, it, vi } from 'vitest';
import * as CallDeductions from './HorseCallDeductions.js';
import * as Eval from './HorseEval.js';
import * as Ev from './HorseEvEngine.js';
import { HorseMind } from './HorseMind.js';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import { horseCallDeductionFraction } from './HorseCallDeductions.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
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
    expect(ev.mock.calls.at(-1)?.[0].rakeMarg).toBeCloseTo(1 / 40, 10);
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
