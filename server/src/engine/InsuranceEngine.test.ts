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
    'nlh',
    false,
    insuranceEquity(leaderCards, [oppCards], board, 'nlh')
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

    // REFERENCE PARITY 2026-08-26: insured amount = the max-insurable slice
    // of the POT (the winnings), no longer capped at the leader's own stake.
    // The reference dialog's max insured pot is ~the pot itself.
    expect(o.insuredAmount).toBe(300);
    // The leader's committed chips still ride the offer for Break Even.
    expect(o.atRisk).toBe(100);

    // POKERBROS PARITY 2026-08-28 (Dan's ruling): the fee is charged only
    // when the leader WINS; a loss pays the insured amount fee-free. Fair
    // fee satisfies fee*pWin = insured*pLoss, margin 1.2 on top:
    // premium = insured * pLoss/pWin * 1.2.
    const lossProb = 1 - o.equity / 100;
    const winProb = o.equity / 100;
    const expectedPremium = Math.round(((300 * lossProb * 1.2) / winProb) * 100) / 100;
    expect(o.premium).toBeCloseTo(expectedPremium, 2);

    // Player EV is negative (fair premium would be without the 1.2 margin).
    const fairPremium = (300 * lossProb) / winProb;
    expect(o.premium).toBeGreaterThan(fairPremium);
    expect(o.premium / fairPremium).toBeCloseTo(1.2, 2);
  });

  it('a premium that rounds to 0.00 is uninsurable - no free contracts (FINAL AUDIT 2026-08-26)', () => {
    // Dust pot: insured 0.01, premium rounds to 0.00 - without the guard the
    // union bank would fund a payout it never collected a cent for.
    const offers = offerLeader(e, 0.01, 0.01);
    expect(offers).toHaveLength(0);
  });

  it('acceptPartial keeps hundredths-of-a-percent precision (fee shown = fee charged)', () => {
    const offers = offerLeader(e, 100, 300);
    const full = offers[0].fullPremium;
    expect(e.acceptPartial('t1', LEADER, 77.77)).toBe(true);
    const accepted = e.getOffers('t1')[0];
    expect(accepted.coveragePercent).toBe(77.77);
    expect(accepted.premium).toBe(Math.round(full * 0.7777 * 100) / 100);
    expect(accepted.insuredAmount).toBe(Math.round(300 * 0.7777 * 100) / 100);
  });

  it('insures the pot, not the stake - a short leader can still cover the winnings', () => {
    // REFERENCE PARITY 2026-08-26: was "caps the insured amount at the leader
    // at-risk" (40). The reference insures what the leader stands to WIN.
    const offers = offerLeader(e, 40, 300); // leader only has 40 at risk
    expect(offers[0].insuredAmount).toBe(300);
    expect(offers[0].atRisk).toBe(40);
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

  it('settlement: leader LOSES => insured amount paid out, fee WAIVED (parity 2026-08-28)', () => {
    const offers = offerLeader(e);
    const insured = offers[0].insuredAmount;
    expect(e.accept('t1', LEADER)).toBe(true);
    const settlements = e.settle('t1', OPP); // opponent won → leader lost
    const s = settlements[0];
    expect(s.won).toBe(true);
    expect(s.payout).toBe(insured);
    // Dan's ruling: "For Losing: <insured pot>" is literal — no fee on a loss.
    expect(s.premium).toBe(0);
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

describe('InsuranceEngine pricing - chop-aware (PRICING FIX 2026-08-18)', () => {
  const c = (r: string, s2: string) => ({ rank: r, suit: s2 }) as never;

  it('a guaranteed chop is uninsurable - no offer at all', () => {
    const e = new InsuranceEngine();
    e.configure('t1', { enabled: true, houseMargin: 1.2, offerTimeoutSeconds: 15 });
    // Identical rank hole cards on a board neither can beat: every runout chops.
    const hero = [c('2', 'clubs'), c('3', 'clubs')];
    const villain = [c('2', 'diamonds'), c('3', 'diamonds')];
    const liveBoard = [c('K', 'spades'), c('Q', 'spades'), c('J', 'hearts'), c('T', 'hearts')];
    const offers = e.createOffers(
      't1',
      't1:1',
      'L',
      [
        { playerId: 'L', holeCards: hero, atRisk: 100 },
        { playerId: 'O', holeCards: villain, atRisk: 100 },
      ],
      liveBoard,
      200,
      'nlh',
      false,
      insuranceEquity(hero, [villain], liveBoard, 'nlh')
    );
    expect(offers).toHaveLength(0);
  });

  it('a coinflip-given-live spot is UNINSURABLE - fee would reach the payout (2026-08-28)', () => {
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
      'nlh',
      false,
      r
    );
    // POKERBROS PARITY 2026-08-28: with the fee collected only on a WIN,
    // pricing this coinflip-given-live spot gives fee = insured * 0.5/0.5 *
    // 1.2 = 1.2x the payout. A contract where you pay more than the most you
    // can ever get back is not a product — the engine refuses to offer it
    // (uninsurable guard: fee >= insured means no offer).
    expect(offers).toHaveLength(0);
  });

  it('a leader who cannot strictly lose gets no offer (free premium is not a product)', () => {
    // Hero holds the ONLY possible flush (two hearts + two on board);
    // identical ranks otherwise: hero wins on runner-runner hearts, chops
    // everything else - strict loss probability is exactly zero.
    const e = new InsuranceEngine();
    e.configure('t1', { enabled: true, houseMargin: 1.2, offerTimeoutSeconds: 15 });
    const hero = [c('A', 'hearts'), c('Q', 'hearts')];
    const villain = [c('A', 'spades'), c('Q', 'clubs')];
    const liveBoard = [c('2', 'hearts'), c('7', 'hearts'), c('9', 'diamonds')];
    const offers = e.createOffers(
      't1',
      't1:1',
      'L',
      [
        { playerId: 'L', holeCards: hero, atRisk: 100 },
        { playerId: 'O', holeCards: villain, atRisk: 100 },
      ],
      liveBoard,
      200,
      'nlh',
      false,
      insuranceEquity(hero, [villain], liveBoard, 'nlh')
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
describe('settlement - chop shapes (Dan: chopped pot voids insurance)', () => {
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
    // POKERBROS PARITY 2026-08-28: a loss pays the insured amount fee-free.
    expect(s.premium).toBe(0);
  });

  it('a timed-out offer is a FINAL decline (POKERBROS PARITY 2026-08-26)', () => {
    // Dan: "IF A PLAYER DECLINES, THEY DON'T GET OFFERED AGAIN." A timeout is
    // a decline, so the expiry callback must mark declinedForHand.
    const fired: Array<() => void> = [];
    const capturingScheduler = {
      start() {},
      schedule(entry: { callback: () => void }) {
        fired.push(entry.callback);
      },
      cancel() {},
    } as unknown as DeadlineScheduler;
    const eng = new InsuranceEngine(undefined, capturingScheduler);
    eng.configure('t1', { enabled: true, houseMargin: 1.2, maxInsurablePercent: 100 });
    eng.createOffers(
      't1',
      't1:1',
      LEADER,
      [
        { playerId: LEADER, holeCards: leaderCards, atRisk: 100 },
        { playerId: OPP, holeCards: oppCards, atRisk: 100 },
      ],
      board,
      300,
      'nlh',
      false,
      insuranceEquity(leaderCards, [oppCards], board, 'nlh')
    );
    expect(fired).toHaveLength(1);
    fired[0](); // the offer window expires
    const offers = eng.getOffers('t1');
    expect(offers[0].status).toBe('declined');
    expect(offers[0].declinedForHand).toBe(true);
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
