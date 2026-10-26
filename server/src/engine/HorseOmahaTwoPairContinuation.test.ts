import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { freshExploitCounters } from './HorseOpponentExploit.js';
import { seedFastRandom, variantInfo, omahaMadeClass } from './HorseEval.js';
import * as EvEngine from './HorseEvEngine.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, SeatPlayer } from '../types.js';
const suits: Record<string, Card['suit']> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1]] }));
type Variant = 'plo4' | 'plo5' | 'plo6' | 'plo8';
const opp = '10000000-0000-4000-8000-000000000009';
function spot(kind: 'board2p' | 'low2p', variant: Variant = 'plo5', highOnly = false) {
  const board = cards(
    highOnly
      ? kind === 'board2p'
        ? '9c 9d Kh Js'
        : '9c Kd As Th'
      : kind === 'board2p'
        ? '5c 5d Jh 3s'
        : '6c Jd Qs 3h'
  );
  let holding = cards(
    highOnly
      ? kind === 'board2p'
        ? 'Ac Ad 5s 6c 2h'
        : '9d Ks 3h 3s 6c'
      : kind === 'board2p'
        ? 'Ac Ad 8s 9c 7h'
        : '6d Js 5h 5s 9c'
  );
  if (variant === 'plo4' || variant === 'plo8') holding = holding.slice(0, 4);
  if (variant === 'plo6') holding.push(cards(kind === 'board2p' ? 'Kh' : 'Ah')[0]);
  const hero = {
    seat: 2,
    user_id: 'hero',
    username: 'Hero',
    totalInvested: 17,
    stack: 1000,
    bet: 0,
    is_folded: false,
    cards: holding,
  } as SeatPlayer;
  const gs = {
    players: [{ seat: 1, user_id: opp, stack: 995, bet: 5, is_folded: false, cards: [] }, hero],
    communityCards: board,
    pot: 100,
    currentBet: 5,
    minRaise: 5,
    lastRaise: 5,
    stage: 'turn',
    gameVariant: variant,
    bigBlind: 2,
    dealerSeat: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    actionHistory: [
      { stage: 'preflop', seat: 1, userId: opp, action: 'raise', amount: 7 },
      { stage: 'preflop', seat: 2, userId: 'hero', action: 'call', amount: 7 },
      { stage: 'flop', seat: 1, userId: opp, action: 'bet', amount: 10 },
      { stage: 'flop', seat: 2, userId: 'hero', action: 'call', amount: 10 },
      { stage: 'turn', seat: 1, userId: opp, action: 'bet', amount: 5 },
    ],
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}
function memory(variant: Variant) {
  HorseMind.importDurableOpponentProfiles([
    {
      user_id: opp,
      variant,
      mode: 'cash',
      size: 'hu',
      observed_hands: 40,
      initialized: true,
      counters: {
        ...freshExploitCounters(),
        hands: 40,
        vpip: 40,
        pfr: 32,
        betCheckedToOpp: 40,
        betCheckedTo: 32,
      },
    },
  ]);
}
function decide(s: ReturnType<typeof spot>) {
  enableBrainTelemetry();
  drainFires();
  seedFastRandom(10);
  return HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { telemetry: true });
}
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
  drainFires();
});
describe('weak Omaha two-pair continuation reaches the actual EV consumer', () => {
  for (const variant of ['plo4', 'plo5', 'plo6'] as const)
    for (const kind of ['board2p', 'low2p'] as const)
      it(`${variant} ${kind}: budgets the next street and retains a positive-value call`, () => {
        memory(variant);
        const s = spot(kind, variant);
        const cat = HorseLogic.__testables.madeCategory(
          s.hero.cards,
          s.gs.communityCards,
          variantInfo(variant)
        );
        expect(cat).toBe(3);
        expect(omahaMadeClass(s.hero.cards, s.gs.communityCards, cat).cls).toBe(kind);
        const spy = vi.spyOn(EvEngine, 'evaluateSpot');
        const decision = decide(s);
        const input = spy.mock.calls.find(([s]) => s.continuation)?.[0];
        expect(input).toBeDefined();
        const plan = input!.continuation!,
          c = Math.min(input!.toCall, input!.stack),
          pot = input!.pot + c,
          b = Math.min(plan.betFraction * pot, input!.stack - c, plan.opponentStack),
          e = input!.equity;
        // Independent one-street tree: checked showdown or best of call/fold.
        const expected =
          (1 - plan.betProbability) * e * pot +
          plan.betProbability * Math.max(0, e * (pot + 2 * b) - b) -
          c;
        const actual = spy.mock.results[
          spy.mock.calls.findIndex(([s]) => s === input)
        ].value.candidates.find((c: { kind: string }) => c.kind === 'call').ev;
        expect(actual).toBeCloseTo(expected);
        expect(actual).toBeGreaterThan(0);
        expect(decision.action).toBe('call');
        expect(drainFires().map((f) => f.feature)).toContain('horse_continuation_budget_call');
      });
  it('preserves actual flush draws, weak trips, nuts and both additional boards', () => {
    for (const control of ['draw', 'trips', 'nuts', 'board2', 'board3']) {
      HorseMind.reset();
      memory('plo5');
      const s = spot('board2p');
      if (control === 'draw') s.gs.communityCards = cards('5c 5d Jc 3s');
      if (control === 'trips') s.hero.cards = cards('5h 8c 9d Ts 2c');
      if (control === 'nuts') s.hero.cards = cards('5h 5s Ac 2d 8c');
      if (control === 'board2') s.gs.communityCards2 = cards('6h 7h 8d 9s');
      if (control === 'board3') s.gs.communityCards3 = cards('6h 7h 8d 9s');
      const spy = vi.spyOn(EvEngine, 'evaluateSpot');
      decide(s);
      expect(
        spy.mock.calls.some(([s]) => s.continuation),
        control
      ).toBe(false);
      spy.mockRestore();
    }
  });
  it('keeps missing-read fallback and PLO8 possible-low runouts separate', () => {
    const spy = vi.spyOn(EvEngine, 'evaluateSpot');
    decide(spot('board2p'));
    expect(spy.mock.calls.some(([s]) => s.continuation)).toBe(false);
    spy.mockClear();
    memory('plo8');
    decide(spot('board2p', 'plo8'));
    expect(spy.mock.calls.some(([s]) => s.continuation)).toBe(false);
    spy.mockClear();
    decide(spot('board2p', 'plo8', true));
    expect(spy.mock.calls.some(([s]) => s.continuation)).toBe(true);
  });
});
