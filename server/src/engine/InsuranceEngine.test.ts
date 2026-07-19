/**
 * INSURANCE ENGINE — offer pricing (20% house edge), at-risk sizing, per-street
 * merge, and settlement (FIX-A12).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InsuranceEngine } from './InsuranceEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const stubScheduler = {
  start() {},
  schedule() {},
  cancel() {},
} as unknown as DeadlineScheduler;

const S = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' } as const;
const c = (rank: CardRank, suit: keyof typeof S): Card => ({ rank, suit: S[suit] as CardSuit });

// Leader = trip aces; opponent = K-high club flush draw; 1 card to come.
// insuranceEquity = 37/44 ≈ 84.1% for the leader.
const LEADER = 'L';
const OPP = 'O';
const leaderCards = [c('A', 'h'), c('A', 'd')];
const oppCards = [c('K', 'c'), c('Q', 'c')];
const board = [c('A', 's'), c('7', 'c'), c('2', 'c'), c('9', 'h')];

function mkEngine() {
  const e = new InsuranceEngine(undefined, stubScheduler);
  e.configure('t1', { enabled: true, houseMargin: 1.2, maxInsurablePercent: 100 });
  return e;
}

function offerLeader(e: InsuranceEngine, atRisk = 100, pot = 300) {
  return e.createOffers(
    't1',
    't1:1',
    LEADER,
    [
      { playerId: LEADER, holeCards: leaderCards, atRisk },
      { playerId: OPP, holeCards: oppCards, atRisk: 100 },
    ],
    board,
    pot,
    'nlh'
  );
}

describe('InsuranceEngine.createOffers', () => {
  let e: InsuranceEngine;
  beforeEach(() => {
    e = mkEngine();
  });

  it('offers only the leader, priced vs the known opponent with a 20% edge', () => {
    const offers = offerLeader(e, 100, 300);
    expect(offers).toHaveLength(1);
    const o = offers[0];
    expect(o.playerId).toBe(LEADER);
    expect(o.equity).toBeCloseTo(84.1, 0);

    // Insured amount = the leader's at-risk chips (capped by pot).
    expect(o.insuredAmount).toBe(100);

    // Premium = insured * lossProbability * 1.20 (the 20% house edge).
    const lossProb = 1 - o.equity / 100;
    const expectedPremium = Math.round(100 * lossProb * 1.2 * 100) / 100;
    expect(o.premium).toBeCloseTo(expectedPremium, 2);

    // Player EV is negative (fair premium would be without the 1.2 margin).
    const fairPremium = 100 * lossProb;
    expect(o.premium).toBeGreaterThan(fairPremium);
    expect(o.premium / fairPremium).toBeCloseTo(1.2, 2);
  });

  it('caps the insured amount at the leader at-risk, not the pot', () => {
    const offers = offerLeader(e, 40, 300); // leader only has 40 at risk
    expect(offers[0].insuredAmount).toBe(40);
  });

  it('settlement: leader WINS => premium charged, no payout (house keeps premium)', () => {
    offerLeader(e);
    expect(e.accept('t1', LEADER)).toBe(true);
    const settlements = e.settle('t1', LEADER); // leader is the winner
    expect(settlements).toHaveLength(1);
    const s = settlements[0];
    expect(s.won).toBe(false); // insurance did not pay
    expect(s.payout).toBe(0);
    expect(s.premium).toBeGreaterThan(0);
    // Bank delta = premium - payout > 0 (house profit this hand).
    expect(s.premium - s.payout).toBeGreaterThan(0);
  });

  it('settlement: leader LOSES => insured amount paid out', () => {
    const offers = offerLeader(e);
    const insured = offers[0].insuredAmount;
    expect(e.accept('t1', LEADER)).toBe(true);
    const settlements = e.settle('t1', OPP); // opponent won → leader lost
    const s = settlements[0];
    expect(s.won).toBe(true);
    expect(s.payout).toBe(insured);
  });

  it('per-street: accepted coverage is preserved (leader not re-offered)', () => {
    offerLeader(e);
    expect(e.accept('t1', LEADER)).toBe(true);
    // Next street re-runs createOffers for the same leader — must NOT wipe the
    // accepted coverage nor create a duplicate offer.
    const reoffer = offerLeader(e);
    expect(reoffer).toHaveLength(0);
    const kept = e.getOffers('t1');
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe('accepted');
  });
});
