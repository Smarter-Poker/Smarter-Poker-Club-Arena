/**
 * POKERBROS PARITY 2026-08-26 (Dan) — the leader HANDOFF rules, pinned:
 *
 *   "IF HERO HAS THE BEST HAND ON THE FLOP, AND TAKES OR REJECTS INSURANCE,
 *    THEN THE VILLAIN HAS THE BEST HAND ON THE TURN, THEY GET TO ACCEPT OR
 *    DECLINE INSURANCE. IF A PLAYER DECLINES, THEY DON'T GET OFFERED AGAIN."
 *
 * Three layers make that true and each is pinned here:
 *   1. InsuranceEngine.createOffers: a decline by player A never blocks an
 *      offer to player B when B takes the lead on a later street.
 *   2. ServerTableEngineRunout.insurancePauseStillLive: the per-street pause
 *      survives as long as ANY all-in player has not finally declined — the
 *      2026-08-26 fix; before it, the leader declining collapsed the pause
 *      and the villain could never be offered.
 *   3. Timeout = decline = final (pinned in InsuranceEngine.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { InsuranceEngine } from './InsuranceEngine.js';
import { insuranceEquity } from './InsuranceEquity.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const stubScheduler = {
  start() {},
  schedule() {},
  cancel() {},
} as unknown as DeadlineScheduler;

const S = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' } as const;
const c = (rank: CardRank, suit: keyof typeof S): Card => ({ rank, suit: S[suit] as CardSuit });

// A spot where the lead genuinely changes street to street AND both leaders
// can still strictly lose (a drawing-dead opponent makes the leader
// uninsurable by design — no offer at all):
// HERO: Kh Kd — flops TOP SET, leads the flop.
// VILLAIN: Ac 8c — flops the nut flush draw; TURN 5c completes it: villain
// leads, while hero redraws to a boat/quads (Kc + any board pair), so
// villain's turn offer is a real contract.
const HERO = 'hero';
const VILLAIN = 'villain';
const heroCards = [c('K', 'h'), c('K', 'd')];
const villainCards = [c('A', 'c'), c('8', 'c')];
const flop = [c('K', 's'), c('2', 'c'), c('9', 'c')];
const turn = [...flop, c('5', 'c')];

const allIn = [
  { playerId: HERO, holeCards: heroCards, atRisk: 100 },
  { playerId: VILLAIN, holeCards: villainCards, atRisk: 100 },
];

function pricing(leaderId: string, liveBoard: Card[]) {
  const leader = allIn.find((player) => player.playerId === leaderId)!;
  return insuranceEquity(
    leader.holeCards,
    allIn.filter((player) => player.playerId !== leaderId).map((player) => player.holeCards),
    liveBoard,
    'nlh'
  );
}

function mkEngine() {
  const e = new InsuranceEngine(undefined, stubScheduler);
  e.configure(TABLE, { enabled: true, houseMargin: 1.2, maxInsurablePercent: 100 });
  return e;
}

describe('leader handoff - a decline by one player never blocks the other', () => {
  it('hero declines on the flop; villain (new turn leader) still gets an offer', () => {
    const e = mkEngine();

    // Street 1 (flop): hero leads and is offered.
    const flopOffers = e.createOffers(
      TABLE,
      't:1',
      HERO,
      allIn,
      flop,
      200,
      'nlh',
      false,
      pricing(HERO, flop)
    );
    expect(flopOffers).toHaveLength(1);
    expect(flopOffers[0].playerId).toBe(HERO);

    // Hero declines — FINAL for the hand.
    e.decline(TABLE, HERO, true);
    expect(e.getOffers(TABLE)[0].declinedForHand).toBe(true);

    // Street 2 (turn): the flush came in, villain leads now. The flow guard
    // clears pending offers then re-offers the NEW leader.
    e.clearPendingOffers(TABLE);
    const turnOffers = e.createOffers(
      TABLE,
      't:1',
      VILLAIN,
      allIn,
      turn,
      200,
      'nlh',
      false,
      pricing(VILLAIN, turn)
    );
    expect(turnOffers).toHaveLength(1);
    expect(turnOffers[0].playerId).toBe(VILLAIN);

    // Hero's final decline is still on record next to villain's live offer.
    const all = e.getOffers(TABLE);
    expect(all.some((o) => o.playerId === HERO && o.declinedForHand)).toBe(true);
    expect(all.some((o) => o.playerId === VILLAIN && o.status === 'offered')).toBe(true);
  });

  it('a player who ACCEPTED keeps coverage and is not re-offered, but is not "declined" either', () => {
    const e = mkEngine();
    e.createOffers(TABLE, 't:1', HERO, allIn, flop, 200, 'nlh', false, pricing(HERO, flop));
    expect(e.accept(TABLE, HERO)).toBe(true);

    // Re-running the offer step for the same leader must not duplicate or wipe.
    const reoffer = e.createOffers(
      TABLE,
      't:1',
      HERO,
      allIn,
      turn,
      200,
      'nlh',
      false,
      pricing(HERO, turn)
    );
    expect(reoffer).toHaveLength(0);
    const kept = e.getOffers(TABLE);
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe('accepted');
    expect(kept[0].declinedForHand).toBe(false);
  });
});

describe('insurancePauseStillLive - the per-street pause survives a leader decline', () => {
  function mkTableEngine() {
    const engine = new ServerTableEngine(TABLE) as unknown as {
      insuranceEngine: InsuranceEngine;
      insurancePauseStillLive(players: Array<{ playerId: string }>): boolean;
    };
    engine.insuranceEngine.configure(TABLE, {
      enabled: true,
      houseMargin: 1.2,
      offerTimeoutSeconds: 15,
    });
    return engine;
  }
  const bothPlayers = [{ playerId: HERO }, { playerId: VILLAIN }];

  it('no offers yet: pause lives (nobody has declined anything)', () => {
    const engine = mkTableEngine();
    expect(engine.insurancePauseStillLive(bothPlayers)).toBe(true);
  });

  it('leader declined, villain never offered: pause LIVES - the 2026-08-26 fix', () => {
    const engine = mkTableEngine();
    engine.insuranceEngine.createOffers(
      TABLE,
      't:1',
      HERO,
      allIn,
      flop,
      200,
      'nlh',
      false,
      pricing(HERO, flop)
    );
    engine.insuranceEngine.decline(TABLE, HERO, true);
    // Before the fix this returned false (anyEligibleForInsurance saw only
    // the declined entry) and the villain never got their turn offer.
    expect(engine.insurancePauseStillLive(bothPlayers)).toBe(true);
  });

  it('EVERY all-in player has finally declined: pause collapses to the paced runout', () => {
    const engine = mkTableEngine();
    engine.insuranceEngine.createOffers(
      TABLE,
      't:1',
      HERO,
      allIn,
      flop,
      200,
      'nlh',
      false,
      pricing(HERO, flop)
    );
    engine.insuranceEngine.decline(TABLE, HERO, true);
    engine.insuranceEngine.clearPendingOffers(TABLE);
    engine.insuranceEngine.createOffers(
      TABLE,
      't:1',
      VILLAIN,
      allIn,
      turn,
      200,
      'nlh',
      false,
      pricing(VILLAIN, turn)
    );
    engine.insuranceEngine.decline(TABLE, VILLAIN, true);
    expect(engine.insurancePauseStillLive(bothPlayers)).toBe(false);
  });

  it('a leader who accepted keeps the pause alive (coverage rides to settlement)', () => {
    const engine = mkTableEngine();
    engine.insuranceEngine.createOffers(
      TABLE,
      't:1',
      HERO,
      allIn,
      flop,
      200,
      'nlh',
      false,
      pricing(HERO, flop)
    );
    engine.insuranceEngine.accept(TABLE, HERO);
    expect(engine.insurancePauseStillLive(bothPlayers)).toBe(true);
  });
});
