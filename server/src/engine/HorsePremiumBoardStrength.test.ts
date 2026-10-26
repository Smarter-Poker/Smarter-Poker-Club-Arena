import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import {
  boardHasPassedPremium,
  isPremiumMadeHand,
  holdemPremiumAggressionVerdict,
} from './HorseHoldemPremiumAggression.js';
const suits = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const;
const cards = (s: string): Card[] =>
  s
    .split(' ')
    .map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1] as keyof typeof suits] }));
describe('premium value uses the best five cards', () => {
  it('recognizes Broadway made by AK without an ace or king on the board', () => {
    expect(isPremiumMadeHand(cards('As Kd'), cards('Th Jc Qd 9s 2h'))).toBe(true);
  });
  it('does not classify a board-only quads as premium value', () => {
    expect(isPremiumMadeHand(cards('As Kd'), cards('9h 9c 9d 9s Ac'))).toBe(false);
  });
  it('does not force value with a board-only straight', () => {
    expect(isPremiumMadeHand(cards('Qs Qd'), cards('9h Tc Jd Qc Ks'))).toBe(false);
  });
  it('keeps betting a nut straight made with AK on four connected ranks', () => {
    expect(boardHasPassedPremium(cards('As Kd'), cards('Th Jc Qd Ks 2h'))).toBe(false);
  });
  it('keeps betting a full house despite four to a straight', () => {
    expect(boardHasPassedPremium(cards('Qs Qd'), cards('Qh Jc Td 9s 9h'))).toBe(false);
  });
  it('still defers an overpair on a four-straight board', () => {
    expect(boardHasPassedPremium(cards('As Ad'), cards('9h Tc Jd Qs 2h'))).toBe(true);
  });
  it('still defers a straight when the board allows a higher straight', () => {
    expect(boardHasPassedPremium(cards('As Kd'), cards('2h 3c 4d 5s 9h'))).toBe(true);
  });
  it('the live rule emits a value bet with broadway, without forcing a board-only bet', () => {
    const input = {
      gameVariant: 'nlh',
      multiBoard: false,
      stage: 'river',
      board: cards('Th Jc Qd Ks 2h'),
      hero: { seat: 1, user_id: 'hero', cards: cards('As Kd'), stack: 1000, bet: 0 },
      players: [
        { seat: 2, user_id: 'other', is_folded: false, is_all_in: false, stack: 1000, bet: 0 },
      ],
      pot: 100,
      currentBet: 0,
      bigBlind: 2,
      legalActions: ['check', 'bet', 'all_in'],
      minRaiseTo: 2,
      maxRaiseTo: 1000,
    };
    expect(holdemPremiumAggressionVerdict({ action: 'check' }, input)?.decision.action).toBe('bet');
    expect(
      holdemPremiumAggressionVerdict(
        { action: 'check' },
        { ...input, board: cards('9h 9c 9d 9s Ac') }
      )
    ).toBeNull();
  });
});
