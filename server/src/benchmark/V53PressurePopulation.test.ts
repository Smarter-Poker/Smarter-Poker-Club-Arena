import { describe, expect, it } from 'vitest';
import type { Card, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import { pressureOpponentDecision, V53_PRESSURE_POPULATION } from './V53PressurePopulation.js';

const cards = (rs: string): Card[] =>
  rs.split(' ').map((s) => ({
    rank: s[0] as Card['rank'],
    suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[s[1] as 's'],
  }));
const player = (seat: number, holding = 'As Ks'): SeatPlayer => ({
  seat,
  user_id: `pressure-${seat}`,
  username: `P${seat}`,
  cards: cards(holding),
  stack: 200,
  bet: 0,
  totalInvested: 0,
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  is_horse: seat === 1,
});
function state(overrides: Partial<HorseGameStateV2> = {}): HorseGameStateV2 {
  return {
    players: [player(1), player(2)],
    communityCards: [],
    pot: 3,
    currentBet: 2,
    minRaise: 2,
    stage: 'preflop',
    gameVariant: 'nlh',
    bigBlind: 2,
    legalActions: ['fold', 'call', 'raise'],
    toCall: 2,
    minRaiseTo: 4,
    maxRaiseTo: 200,
    actionHistory: [],
    ...overrides,
  } as HorseGameStateV2;
}

describe('the V53 pressure workload is explicit public information, not market calibration', () => {
  it('names a separate adversarial population, never the calibrated human id', () => {
    expect(V53_PRESSURE_POPULATION.id).toBe('v53_pressure_stress_v1');
  });
  it('uses only the acting seat cards and public state', () => {
    const p = player(2);
    const a = state({ players: [player(1, '2s 3h'), p] });
    const b = state({ players: [player(1, 'Ah Ad'), p] });
    expect(pressureOpponentDecision(p, a, () => 0.4)).toEqual(
      pressureOpponentDecision(p, b, () => 0.4)
    );
  });
  it('does not mutate the public context, own cards or the offered action menu', () => {
    const p = player(2, 'As Ks Qh Jh Ts');
    const gs = state({ gameVariant: 'plo5', players: [player(1, 'Ac Kc Qd Jd Th'), p] });
    const before = JSON.stringify({ p, gs });
    pressureOpponentDecision(p, gs, () => 0.4);
    expect(JSON.stringify({ p, gs })).toBe(before);
  });
  it('opens a strong holding at the canonical cap and never exceeds it', () => {
    const p = player(2);
    const gs = state({ minRaiseTo: 4, maxRaiseTo: 7.13 });
    expect(pressureOpponentDecision(p, gs, () => 0.5)).toEqual({
      action: 'raise',
      amount: 7,
      thinkTime: 0,
    });
    expect(pressureOpponentDecision(p, { ...gs, maxRaiseTo: 6.31 }, () => 0.5)).toEqual({
      action: 'raise',
      amount: 6.31,
      thinkTime: 0,
    });
  });
  it('never manufactures a raise when the controller offers none', () => {
    expect(
      pressureOpponentDecision(
        player(2),
        state({
          legalActions: ['fold', 'call'],
          minRaiseTo: null,
          maxRaiseTo: null,
        }),
        () => 0.5
      )
    ).toEqual({ action: 'call', thinkTime: 0 });
  });
  it('a river flush calls; a weak river holding folds', () => {
    const gs = state({
      stage: 'river',
      communityCards: cards('Qs 8s 4s 7d 2h'),
      toCall: 20,
      currentBet: 20,
      legalActions: ['fold', 'call'],
    });
    expect(pressureOpponentDecision(player(2), gs, () => 0.5).action).toBe('call');
    expect(pressureOpponentDecision(player(2, 'Ah Kd'), gs, () => 0.5).action).toBe('fold');
  });
  it('refuses an undeclared variant rather than substituting hold em', () => {
    expect(() =>
      pressureOpponentDecision(player(2), state({ gameVariant: 'short_deck' }), () => 0.5)
    ).toThrow(/unsupported variant/);
  });
  it('does not offer a direct counter initializer', () => {
    expect(V53_PRESSURE_POPULATION.initializeSandbox).toBeUndefined();
  });
});
