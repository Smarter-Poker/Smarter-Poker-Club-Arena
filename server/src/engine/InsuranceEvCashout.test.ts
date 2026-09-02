/**
 * EV CASHOUT — engine contract tests (2026-08-28).
 *
 * The third answer to an insurance offer: lock insurable-pot x equity x
 * (1 - fee) now. These pin:
 *   1. the offer carries a server-priced evCashoutAmount,
 *   2. acceptEvCashout locks it, resolves the offer (allResponded), and
 *      cancels the expiry deadline,
 *   3. settle() pays the locked amount REGARDLESS of outcome, premium 0,
 *      kind 'ev_cashout',
 *   4. cashout disabled by config => no evCashoutAmount on the offer and
 *      acceptEvCashout refuses,
 *   5. the classic insurance branches still carry kind 'insurance'.
 */
import { describe, it, expect } from 'vitest';
import { InsuranceEngine } from './InsuranceEngine.js';
import type { Card } from '../types.js';

const LEADER = 'leader-1';
const OPP = 'opp-1';

const c = (rank: string, suit: string) => ({ rank, suit }) as never as Card;

// Top set vs flush draw on the turn — the suite's standard live spot.
const leaderCards = [c('A', 'spades'), c('A', 'hearts')];
const oppCards = [c('7', 'clubs'), c('8', 'clubs')];
const board = [c('A', 'clubs'), c('K', 'clubs'), c('2', 'diamonds'), c('9', 'hearts')];

function mkEngine(configOver: Record<string, unknown> = {}): InsuranceEngine {
  const e = new InsuranceEngine();
  e.configure('t1', {
    enabled: true,
    houseMargin: 1.2,
    maxInsurablePercent: 100,
    offerTimeoutSeconds: 15,
    ...configOver,
  });
  return e;
}

function offerLeader(e: InsuranceEngine, pot = 300) {
  return e.createOffers(
    't1',
    't1:1',
    LEADER,
    [
      { playerId: LEADER, holeCards: leaderCards, atRisk: 100 },
      { playerId: OPP, holeCards: oppCards, atRisk: 100 },
    ],
    board,
    pot,
    'nlh'
  );
}

describe('EV cashout - offer pricing', () => {
  it('the offer quotes insurable pot x equity x (1 - 1% fee), to the cent', () => {
    const offers = offerLeader(mkEngine(), 300);
    expect(offers).toHaveLength(1);
    const o = offers[0];
    const expected = Math.round(300 * (o.equity / 100) * 0.99 * 100) / 100;
    expect(o.evCashoutAmount).toBeCloseTo(expected, 2);
    expect(o.evCashoutAmount!).toBeGreaterThan(0);
  });

  it('config off => no cashout on the offer, and acceptEvCashout refuses', () => {
    const e = mkEngine({ evCashoutEnabled: false });
    const offers = offerLeader(e);
    expect(offers[0].evCashoutAmount).toBeUndefined();
    expect(e.acceptEvCashout('t1', LEADER).ok).toBe(false);
    // The offer is untouched — still answerable.
    expect(e.getOffers('t1')[0].status).toBe('offered');
  });
});

describe('EV cashout - accept + settle', () => {
  it('locks the quote, resolves the offer, and settles at the locked amount when the leader WINS', () => {
    const e = mkEngine();
    const offers = offerLeader(e);
    const quote = offers[0].evCashoutAmount!;

    const r = e.acceptEvCashout('t1', LEADER);
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(quote);
    expect(e.getOffers('t1')[0].status).toBe('cashed_out');
    // The runout pause ends the moment the decision lands.
    expect(e.allResponded('t1')).toBe(true);

    const settlements = e.settle('t1', LEADER); // leader wins the board
    expect(settlements).toHaveLength(1);
    const s = settlements[0];
    expect(s.kind).toBe('ev_cashout');
    expect(s.payout).toBe(quote); // paid even though they "won" — bank owns the win
    expect(s.premium).toBe(0);
    expect(s.insuredAmount).toBe(0);
  });

  it('settles at the SAME locked amount when the leader LOSES', () => {
    const e = mkEngine();
    const offers = offerLeader(e);
    const quote = offers[0].evCashoutAmount!;
    expect(e.acceptEvCashout('t1', LEADER).ok).toBe(true);

    const settlements = e.settle('t1', OPP); // leader lost the board
    const s = settlements[0];
    expect(s.kind).toBe('ev_cashout');
    expect(s.payout).toBe(quote);
    expect(s.premium).toBe(0);
  });

  it('a second acceptEvCashout is refused (the offer already resolved)', () => {
    const e = mkEngine();
    offerLeader(e);
    expect(e.acceptEvCashout('t1', LEADER).ok).toBe(true);
    expect(e.acceptEvCashout('t1', LEADER).ok).toBe(false);
    expect(e.acceptPartial('t1', LEADER, 100)).toBe(false); // and no late insure either
  });

  it('RE-OFFER GUARD: a cashed-out leader is NOT offered again on a later street', () => {
    // Found in line-by-line review 2026-08-28: the no-re-offer guard checked
    // accepted/settled but not cashed_out, so a flop cashout could be offered
    // again on the turn — double-dipping on equity the bank already bought.
    const e = mkEngine();
    offerLeader(e);
    expect(e.acceptEvCashout('t1', LEADER).ok).toBe(true);
    // Next street: the per-street flow clears pending offers and re-creates.
    e.clearPendingOffers('t1');
    const reoffer = offerLeader(e);
    expect(reoffer).toHaveLength(0);
    // The locked cashout is untouched and still settles exactly once.
    const kept = e.getOffers('t1');
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe('cashed_out');
    const settlements = e.settle('t1', LEADER);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].kind).toBe('ev_cashout');
  });

  it('classic insurance settlements carry kind "insurance"', () => {
    const e = mkEngine();
    offerLeader(e);
    expect(e.accept('t1', LEADER)).toBe(true);
    const settlements = e.settle('t1', LEADER);
    expect(settlements[0].kind).toBe('insurance');
  });
});
