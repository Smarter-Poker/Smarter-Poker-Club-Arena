/**
 * PREFLOP INSURANCE — engine contract tests (2026-08-28).
 *
 * Dan: "IT ONLY OFFERS AFTER THE FLOP — THIS SHOULD BE OFFERED PRE FLOP, AND
 * REOFFERED ON THE FLOP." These pin the engine half of that:
 *   1. an offer is created on the EMPTY board (sampled pricing, boardLength 0),
 *   2. a PREFLOP decline is street-only (declinedForHand false) and the same
 *      leader can be offered again on the flop,
 *   3. a PREFLOP timeout is street-only too, while a FLOP timeout stays FINAL
 *      (the 2026-08-26 rule unchanged from the flop onward),
 *   4. a preflop ACCEPT locks coverage — no flop re-offer.
 */
import { describe, it, expect } from 'vitest';
import { InsuranceEngine } from './InsuranceEngine.js';
import type { Card } from '../types.js';

const LEADER = 'leader-1';
const OPP = 'opp-1';
const c = (rank: string, suit: string) => ({ rank, suit }) as never as Card;

// AA vs KQo — a clear preflop favorite, no board.
const leaderCards = [c('A', 'spades'), c('A', 'hearts')];
const oppCards = [c('K', 'clubs'), c('Q', 'diamonds')];
const flopBoard = [c('2', 'clubs'), c('7', 'diamonds'), c('9', 'spades')];

function mkEngine(): InsuranceEngine {
  const e = new InsuranceEngine();
  e.configure('t1', {
    enabled: true,
    houseMargin: 1.2,
    maxInsurablePercent: 100,
    offerTimeoutSeconds: 15,
  });
  return e;
}

function offer(e: InsuranceEngine, board: Card[], pot = 200) {
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

describe('preflop offer creation', () => {
  it('creates an offer on the EMPTY board with sampled pricing and boardLength 0', () => {
    const offers = offer(mkEngine(), []);
    expect(offers).toHaveLength(1);
    const o = offers[0];
    expect(o.boardLength).toBe(0);
    // AA vs KQo is ~85/15 — the sampled equity must land in a sane band.
    expect(o.equity).toBeGreaterThan(75);
    expect(o.equity).toBeLessThan(95);
    expect(o.fullPremium).toBeGreaterThan(0);
    expect(o.fullInsuredAmount).toBe(200);
    expect(o.evCashoutAmount).toBeGreaterThan(0);
  });

  it('a flop offer records boardLength 3 (finality boundary)', () => {
    const offers = offer(mkEngine(), flopBoard);
    expect(offers[0].boardLength).toBe(3);
  });
});

describe('preflop decline is street-only; flop decline is final', () => {
  it('preflop decline (forHand=false) leaves the leader re-offerable on the flop', () => {
    const e = mkEngine();
    offer(e, []);
    // The runout layer computes forHand from boardLength (<3 → street-only).
    e.decline('t1', LEADER, false);
    expect(e.getOffers('t1')[0].declinedForHand).toBe(false);

    // Flop: the per-street flow clears pending and re-creates for the leader.
    e.clearPendingOffers('t1');
    const reoffer = offer(e, flopBoard);
    expect(reoffer).toHaveLength(1);
    expect(reoffer[0].boardLength).toBe(3);
  });

  it('a preflop ACCEPT locks coverage - no flop re-offer', () => {
    const e = mkEngine();
    offer(e, []);
    expect(e.accept('t1', LEADER)).toBe(true);
    e.clearPendingOffers('t1');
    expect(offer(e, flopBoard)).toHaveLength(0);
  });
});

describe('timeout finality follows the street', () => {
  function expireWith(board: Card[]): boolean {
    // Capturing scheduler: grab the expiry callback and fire it by hand.
    const fired: Array<() => void> = [];
    const capturingScheduler = {
      start() {},
      schedule(entry: { callback: () => void }) {
        fired.push(entry.callback);
      },
      cancel() {},
    };
    const e = new InsuranceEngine(undefined, capturingScheduler as never);
    e.configure('t1', {
      enabled: true,
      houseMargin: 1.2,
      maxInsurablePercent: 100,
      offerTimeoutSeconds: 15,
    });
    e.createOffers(
      't1',
      't1:1',
      LEADER,
      [
        { playerId: LEADER, holeCards: leaderCards, atRisk: 100 },
        { playerId: OPP, holeCards: oppCards, atRisk: 100 },
      ],
      board,
      200,
      'nlh'
    );
    expect(fired).toHaveLength(1);
    fired[0]();
    return e.getOffers('t1')[0].declinedForHand;
  }

  it('PREFLOP timeout → street-only decline (re-offered on the flop)', () => {
    expect(expireWith([])).toBe(false);
  });

  it('FLOP timeout → FINAL decline (2026-08-26 rule unchanged)', () => {
    expect(expireWith(flopBoard)).toBe(true);
  });
});
