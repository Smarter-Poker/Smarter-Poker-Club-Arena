/**
 * INSURANCE EQUITY — exact enumeration vs KNOWN opponent cards (FIX-A12 core).
 *
 * Deterministic, hand-countable scenarios: equity must reflect the true all-in
 * outcome against the actual opponent hand, not a random one.
 */
import { describe, it, expect } from 'vitest';
import { insuranceEquity, leaderOuts } from './InsuranceEquity.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const S = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' } as const;
const c = (rank: CardRank, suit: keyof typeof S): Card => ({ rank, suit: S[suit] as CardSuit });

describe('insuranceEquity - completed board (0 cards to come)', () => {
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

describe('insuranceEquity - one card to come (exact enumeration)', () => {
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

// ═══════════════════════════════════════════════════════════════════════════
// POKERBROS PARITY 2026-08-26 — leaderOuts: the specific next-street cards
// the popup shows the leader ("these beat you").
// ═══════════════════════════════════════════════════════════════════════════
describe('leaderOuts - the cards that put the leader behind on the next street', () => {
  it('top set vs flush draw on the turn: exactly the 7 live clubs', () => {
    // 9 clubs remain, but Ac makes hero quads and 9c pairs the board into
    // aces-full — both WIN for the leader and must not be listed as outs.
    const hero = [c('A', 'h'), c('A', 'd')];
    const opp = [c('K', 'c'), c('Q', 'c')];
    const board = [c('A', 's'), c('7', 'c'), c('2', 'c'), c('9', 'h')];
    const outs = leaderOuts(hero, [opp], board, 'nlh');
    expect(outs).toHaveLength(7);
    expect(outs.every((o) => o.suit === 'clubs')).toBe(true);
    const ranks = outs.map((o) => o.rank);
    expect(ranks).not.toContain('A');
    expect(ranks).not.toContain('9');
  });

  it('a leader who cannot be overtaken next street has zero outs against them', () => {
    const hero = [c('A', 'h'), c('A', 'd')];
    const opp = [c('K', 'd'), c('K', 's')];
    // Hero already has quads on the turn.
    const board = [c('A', 's'), c('A', 'c'), c('K', 'h'), c('7', 'd')];
    expect(leaderOuts(hero, [opp], board, 'nlh')).toHaveLength(0);
  });

  it('returns nothing on a complete board or preflop (insurance is flop/turn only)', () => {
    const hero = [c('A', 'h'), c('A', 'd')];
    const opp = [c('K', 'c'), c('Q', 'c')];
    expect(
      leaderOuts(
        hero,
        [opp],
        [c('A', 's'), c('7', 'c'), c('2', 'c'), c('9', 'h'), c('3', 'd')],
        'nlh'
      )
    ).toHaveLength(0);
    expect(leaderOuts(hero, [opp], [], 'nlh')).toHaveLength(0);
  });

  it('normalizes FLO8 and uppercase PLO through the canonical Omaha rule', () => {
    const hero = [c('A', 's'), c('A', 'h'), c('2', 'c'), c('3', 'c')];
    const opp = [c('K', 's'), c('K', 'h'), c('Q', 'c'), c('J', 'c')];
    const board = [c('4', 's'), c('5', 'h'), c('9', 'd'), c('T', 'd')];
    const canonicalOuts = leaderOuts(hero, [opp], board, 'plo8');
    const canonicalPricing = insuranceEquity(hero, [opp], board, 'plo8');

    expect(leaderOuts(hero, [opp], board, 'FLO8')).toEqual(canonicalOuts);
    expect(leaderOuts(hero, [opp], board, 'PLO4')).toEqual(canonicalOuts);
    expect(insuranceEquity(hero, [opp], board, 'FLO8')).toEqual(canonicalPricing);
    expect(insuranceEquity(hero, [opp], board, 'PLO4')).toEqual(canonicalPricing);
  });
});
