/**
 * INSURANCE EQUITY — exact enumeration vs KNOWN opponent cards (FIX-A12 core).
 *
 * Deterministic, hand-countable scenarios: equity must reflect the true all-in
 * outcome against the actual opponent hand, not a random one.
 */
import { describe, it, expect } from 'vitest';
import { insuranceEquity } from './InsuranceEquity.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const S = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' } as const;
const c = (rank: CardRank, suit: keyof typeof S): Card => ({ rank, suit: S[suit] as CardSuit });

describe('insuranceEquity — completed board (0 cards to come)', () => {
  it('leader with quad aces = 100%', () => {
    const hero = [c('A', 'h'), c('A', 'd')];
    const opp = [c('K', 'd'), c('K', 's')];
    const board = [c('A', 's'), c('A', 'c'), c('K', 'h'), c('7', 'd'), c('2', 'c')];
    const r = insuranceEquity(hero, [opp], board, 'nlh');
    expect(r.exact).toBe(true);
    expect(r.equity).toBe(100);
  });

  it('both play a royal flush on the board = 50% (2-way tie)', () => {
    const hero = [c('2', 'h'), c('3', 'h')];
    const opp = [c('4', 'd'), c('5', 'd')];
    const board = [c('A', 's'), c('K', 's'), c('Q', 's'), c('J', 's'), c('T', 's')];
    const r = insuranceEquity(hero, [opp], board, 'nlh');
    expect(r.equity).toBe(50);
  });

  it('leader drawing dead against a full house = 0%', () => {
    const hero = [c('3', 'h'), c('4', 'h')]; // trips on board only
    const opp = [c('A', 'h'), c('A', 'd')]; // 222 full of aces
    const board = [c('2', 'h'), c('2', 'd'), c('2', 'c'), c('5', 's'), c('8', 'h')];
    const r = insuranceEquity(hero, [opp], board, 'nlh');
    expect(r.equity).toBe(0);
  });
});

describe('insuranceEquity — one card to come (exact enumeration)', () => {
  it('top set vs flush draw: leader equity = 37/44 ≈ 84.1%', () => {
    // Hero trip aces; opp K-high club flush draw. 44 unknown cards, 1 to come.
    // 9 clubs remain, but Ac gives hero quads (win) and 9c pairs the board so
    // hero makes aces-full (win, beats the flush). Only the other 7 clubs lose.
    // 37/44 = 84.09% — enumeration correctly catches the board-pairing full house.
    const hero = [c('A', 'h'), c('A', 'd')];
    const opp = [c('K', 'c'), c('Q', 'c')];
    const board = [c('A', 's'), c('7', 'c'), c('2', 'c'), c('9', 'h')];
    const r = insuranceEquity(hero, [opp], board, 'nlh');
    expect(r.exact).toBe(true);
    expect(r.runouts).toBe(44);
    expect(r.equity).toBeCloseTo(84.1, 0);
  });
});
