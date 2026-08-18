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

// ═══════════════════════════════════════════════════════════════════════════
// PRICING FIX 2026-08-18 — the premium prices the CONTRACT, not pot share.
// Settlement pushes on a chop (FIX 118: premium refunded), so the fair
// premium is insured x P(strict loss | not push) x margin. The old formula
// used (1 - potShareEquity), which charged for chop probability the house
// must refund - a near-pure chop priced at ~60% of the stake.
// ═══════════════════════════════════════════════════════════════════════════
import { insuranceEquity } from './InsuranceEquity.js';

describe('InsuranceEngine pricing — chop-aware (PRICING FIX 2026-08-18)', () => {
  const c = (r: string, s2: string) => ({ rank: r, suit: s2 }) as never;

  it('a guaranteed chop is uninsurable — no offer at all', () => {
    const e = new InsuranceEngine();
    e.configure('t1', { enabled: true, houseMargin: 1.2, offerTimeoutSeconds: 15 });
    // Identical rank hole cards on a board neither can beat: every runout chops.
    const offers = e.createOffers(
      't1',
      't1:1',
      'L',
      [
        { playerId: 'L', holeCards: [c('2', 'clubs'), c('3', 'clubs')], atRisk: 100 },
        { playerId: 'O', holeCards: [c('2', 'diamonds'), c('3', 'diamonds')], atRisk: 100 },
      ],
      [c('K', 'spades'), c('Q', 'spades'), c('J', 'hearts'), c('T', 'hearts')],
      200,
      'nlh'
    );
    expect(offers).toHaveLength(0);
  });

  it('a chop-dominated spot prices conditional on the hand being live (push refunds)', () => {
    // AsKs vs AdKd, board 2d 7s 9c: each side has exactly ONE live suit
    // (one board card of it) - runner-runner flush either way, ~91% chop.
    // The contract refunds the premium on every chop, so the price is
    // conditional on not-push: loss/(1-push) = a coinflip given live, and
    // the premium is insured x 0.5 x 1.2 - NOT insured x (1 - potShare)
    // blended over boards the house must refund.
    const leaderCards = [c('A', 'spades'), c('K', 'spades')];
    const oppCards = [c('A', 'diamonds'), c('K', 'diamonds')];
    const board = [c('2', 'diamonds'), c('7', 'spades'), c('9', 'clubs')];

    const r = insuranceEquity(leaderCards, [oppCards], board, 'nlh');
    expect(r.exact).toBe(true);
    expect(r.pushPct).toBeGreaterThan(88); // overwhelmingly a chop
    expect(r.strictLossPct).toBeGreaterThan(3);
    expect(r.strictLossPct).toBeLessThan(6);

    const e = new InsuranceEngine();
    e.configure('t1', { enabled: true, houseMargin: 1.2, offerTimeoutSeconds: 15 });
    const offers = e.createOffers(
      't1',
      't1:1',
      'L',
      [
        { playerId: 'L', holeCards: leaderCards, atRisk: 100 },
        { playerId: 'O', holeCards: oppCards, atRisk: 100 },
      ],
      board,
      200,
      'nlh'
    );
    expect(offers).toHaveLength(1);
    const premium = offers[0].fullPremium;
    const expected = Math.round(100 * (r.strictLossPct / (100 - r.pushPct)) * 1.2 * 100) / 100;
    expect(premium).toBeCloseTo(expected, 2);
    // Symmetric live-suit spot: loss-given-not-push is a coinflip -> ~60.
    expect(premium).toBeGreaterThan(55);
    expect(premium).toBeLessThan(65);
  });

  it('a leader who cannot strictly lose gets no offer (free premium is not a product)', () => {
    // Hero holds the ONLY possible flush (two hearts + two on board);
    // identical ranks otherwise: hero wins on runner-runner hearts, chops
    // everything else - strict loss probability is exactly zero.
    const e = new InsuranceEngine();
    e.configure('t1', { enabled: true, houseMargin: 1.2, offerTimeoutSeconds: 15 });
    const offers = e.createOffers(
      't1',
      't1:1',
      'L',
      [
        { playerId: 'L', holeCards: [c('A', 'hearts'), c('Q', 'hearts')], atRisk: 100 },
        { playerId: 'O', holeCards: [c('A', 'spades'), c('Q', 'clubs')], atRisk: 100 },
      ],
      [c('2', 'hearts'), c('7', 'hearts'), c('9', 'diamonds')],
      200,
      'nlh'
    );
    expect(offers).toHaveLength(0);
  });

  it('with no ties, contract pricing equals the old pricing (regression anchor)', () => {
    // Top set vs flush draw (the existing 37/44 spot): zero push probability,
    // so strictLoss = 1 - equity and both formulas agree to the cent.
    const leaderCards = [c('A', 'spades'), c('A', 'hearts')];
    const oppCards = [c('7', 'clubs'), c('8', 'clubs')];
    const board = [c('A', 'clubs'), c('K', 'clubs'), c('2', 'diamonds'), c('9', 'hearts')];
    const r = insuranceEquity(leaderCards, [oppCards], board, 'nlh');
    expect(r.pushPct).toBe(0);
    expect(r.strictLossPct).toBeCloseTo(100 - r.equity, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DAN'S RULES (2026-08-18): "insurance is only allowed for running it once;
// if the pot is chopped, insurance is voided." Every chop shape pinned.
// ═══════════════════════════════════════════════════════════════════════════
describe('settlement — chop shapes (Dan: chopped pot voids insurance)', () => {
  let e: InsuranceEngine;
  beforeEach(() => {
    e = mkEngine();
  });

  it('leader ties for the pot (chop) => VOID: no premium, no payout', () => {
    offerLeader(e);
    expect(e.accept('t1', LEADER)).toBe(true);
    const settlements = e.settle('t1', [LEADER, OPP]); // chopped pot
    expect(settlements).toHaveLength(1);
    const s = settlements[0];
    expect(s.premium).toBe(0); // refunded — the contract voids
    expect(s.payout).toBe(0);
    expect(s.won).toBe(false);
  });

  it('two OTHER players chop while the leader loses => insurance PAYS', () => {
    const offers = offerLeader(e);
    expect(e.accept('t1', LEADER)).toBe(true);
    // Multi-winner hand that does NOT include the insured leader: the leader
    // genuinely lost their stake — the void rule is about the LEADER sharing
    // a pot, not about any chop anywhere on the table.
    const settlements = e.settle('t1', ['someone-else', 'another-player']);
    const s = settlements[0];
    expect(s.won).toBe(true);
    expect(s.payout).toBe(offers[0].insuredAmount);
    expect(s.premium).toBeGreaterThan(0);
  });

  it('leader among MULTIPLE winners (e.g. side-pot split) => VOID, never double-paid', () => {
    // Pinned conservative semantics: if the insured leader is among the
    // winners of ANY pot in a multi-winner hand, the contract voids —
    // premium refunded, no payout. The house never pays a player who
    // walked away with chips, and the player is never charged for
    // coverage that resolved ambiguously.
    offerLeader(e);
    expect(e.accept('t1', LEADER)).toBe(true);
    const settlements = e.settle('t1', [OPP, LEADER]);
    const s = settlements[0];
    expect(s.premium).toBe(0);
    expect(s.payout).toBe(0);
    expect(s.won).toBe(false);
  });
});
