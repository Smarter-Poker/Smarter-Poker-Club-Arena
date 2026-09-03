/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHO GETS THE SEATS, AND WHO EATS THE DIFFERENCE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is the money path that turns a $5 satellite win into a seat in the
 * Sunday $200 Deep Stack. Until 2026-08-26 it had NO tests, while its own
 * comments recorded three money bugs already found in production: chips
 * destroyed by a raw INSERT, a target pool left one buy-in short per seat, and
 * a remainder that deduped itself into nothing.
 *
 * The satellites run every day and the Deep Stack runs Sunday, so this
 * arithmetic executes for real several times a day from now on.
 */

import { describe, it, expect } from 'vitest';
import { planSatelliteAwards, remainderRecipientIndex } from './satelliteAwardPlan.js';

/** The live shape: a $200 target, so one seat costs 200. */
const TICKET = 200;

describe('a satellite that funded itself', () => {
  it('awards what the pool bought when no guarantee is set', () => {
    // 1,000 chips collected, 200 a seat, no advertised count -> 5 seats.
    const p = planSatelliteAwards({
      pool: 1000,
      ticketCost: TICKET,
      configuredSeats: 0,
      finisherCount: 20,
    });
    expect(p.awardCount).toBe(5);
    expect(p.remainder).toBe(0);
    expect(p.overlay).toBe(0);
  });

  it('pays the fractional leftover to the next finisher down', () => {
    // 1,050 buys 5 seats with 50 left.
    const p = planSatelliteAwards({
      pool: 1050,
      ticketCost: TICKET,
      configuredSeats: 0,
      finisherCount: 20,
    });
    expect(p.awardCount).toBe(5);
    expect(p.remainder).toBe(50);
    // 6th place (index 5) — the first player who did NOT get a seat.
    expect(remainderRecipientIndex(p, 20)).toBe(5);
  });

  it('conserves the pool exactly: seats + remainder = what came in', () => {
    for (const pool of [200, 250, 999, 1000, 1001, 1234.56, 4321]) {
      const p = planSatelliteAwards({
        pool,
        ticketCost: TICKET,
        configuredSeats: 0,
        finisherCount: 50,
      });
      expect(p.awardCount * p.ticketCost + p.remainder).toBeCloseTo(pool, 2);
      expect(p.overlay).toBe(0);
    }
  });
});

describe('a GUARANTEE the field did not fund', () => {
  /**
   * Dan 2026-08-26 set real guarantees: $5 -> 1 seat, $10 -> 2, $25 -> 5.
   * A guarantee is a promise to cover the shortfall, so the seat count must
   * NOT be capped by the pool. These pin that, and pin the size of the bill.
   */
  it('honours the advertised count even when the pool cannot pay for it', () => {
    // The $25 satellite promises 5 seats. Twenty runners at 25 collect ~500.
    const p = planSatelliteAwards({
      pool: 500,
      ticketCost: TICKET,
      configuredSeats: 5,
      finisherCount: 20,
    });
    expect(p.awardCount).toBe(5); // NOT floor(500/200) = 2
    expect(p.remainder).toBe(0); // nothing left over to pay
    expect(p.overlay).toBe(500); // 5 x 200 = 1000 against a 500 pool
  });

  it('reports a zero overlay when the field covered the promise', () => {
    // Forty runners at 25 = 1,000 = exactly five seats. Break-even.
    const p = planSatelliteAwards({
      pool: 1000,
      ticketCost: TICKET,
      configuredSeats: 5,
      finisherCount: 40,
    });
    expect(p.awardCount).toBe(5);
    expect(p.overlay).toBe(0);
    expect(p.remainder).toBe(0);
  });

  it('the live guarantees behave as advertised at their break-even field', () => {
    // Each satellite's real shape, at the 40 entries that fund it.
    const cases = [
      { label: '$5 -> 1 seat', buyIn: 5, seats: 1 },
      { label: '$10 -> 2 seats', buyIn: 10, seats: 2 },
      { label: '$25 -> 5 seats', buyIn: 25, seats: 5 },
    ];
    for (const c of cases) {
      const pool = 40 * c.buyIn; // 200 / 400 / 1000
      const p = planSatelliteAwards({
        pool,
        ticketCost: TICKET,
        configuredSeats: c.seats,
        finisherCount: 40,
      });
      expect(p.awardCount, c.label).toBe(c.seats);
      expect(p.overlay, `${c.label} must break even at 40 entries`).toBe(0);
      expect(p.remainder, c.label).toBe(0);
    }
  });

  it('a guarantee still cannot award a seat to nobody', () => {
    // Five promised, three players finished. The field caps it, the pool does
    // not. Awarding four would seat a player who does not exist.
    const p = planSatelliteAwards({
      pool: 1000,
      ticketCost: TICKET,
      configuredSeats: 5,
      finisherCount: 3,
    });
    expect(p.awardCount).toBe(3);
    // 1000 - 3x200 = 400 genuinely left over, and it must be paid.
    expect(p.remainder).toBe(400);
    // Field exhausted, so it goes to the LAST seat winner, not a 4th player.
    expect(remainderRecipientIndex(p, 3)).toBe(2);
  });
});

describe('no target to send anyone to', () => {
  it('cashes the whole pool to first place when the ticket cost is unknown', () => {
    // ticketCost 0 is the signal that the target is missing or unreadable.
    const p = planSatelliteAwards({
      pool: 750,
      ticketCost: 0,
      configuredSeats: 5,
      finisherCount: 10,
    });
    expect(p.awardCount).toBe(0);
    expect(p.cashWholePoolToFirst).toBe(true);
    expect(p.overlay).toBe(0);
    // An advertised guarantee must NOT conjure seats into a vanished target.
  });

  it('a pool too small for even one seat cashes out rather than under-paying', () => {
    const p = planSatelliteAwards({
      pool: 150,
      ticketCost: TICKET,
      configuredSeats: 0,
      finisherCount: 8,
    });
    expect(p.awardCount).toBe(0);
    expect(p.cashWholePoolToFirst).toBe(true);
  });

  it('never claims a cash-to-first when nobody finished', () => {
    const p = planSatelliteAwards({
      pool: 750,
      ticketCost: 0,
      configuredSeats: 0,
      finisherCount: 0,
    });
    expect(p.awardCount).toBe(0);
    expect(p.cashWholePoolToFirst).toBe(false);
    expect(remainderRecipientIndex(p, 0)).toBeNull();
  });
});

describe('nothing pays out twice, and nothing pays out negative', () => {
  it('a remainder is never negative - a shortfall is the house, not a debt', () => {
    const p = planSatelliteAwards({
      pool: 100,
      ticketCost: TICKET,
      configuredSeats: 3,
      finisherCount: 5,
    });
    expect(p.remainder).toBe(0);
    expect(p.overlay).toBe(500); // 3 x 200 - 100
    expect(remainderRecipientIndex(p, 5)).toBeNull();
  });

  it('an empty or nonsense pool awards nothing at all', () => {
    for (const pool of [0, -5, Number.NaN]) {
      const p = planSatelliteAwards({
        pool,
        ticketCost: TICKET,
        configuredSeats: 0,
        finisherCount: 10,
      });
      expect(p.awardCount).toBe(0);
      expect(p.remainder).toBe(0);
    }
  });

  it('nonsense inputs degrade to zero rather than throwing or awarding', () => {
    const p = planSatelliteAwards({
      pool: Number.NaN,
      ticketCost: Number.NaN,
      configuredSeats: Number.NaN,
      finisherCount: Number.NaN,
    });
    expect(p.awardCount).toBe(0);
    expect(p.remainder).toBe(0);
    expect(p.overlay).toBe(0);
    expect(p.cashWholePoolToFirst).toBe(false);
  });

  it('a fractional guarantee floors rather than rounding a seat into existence', () => {
    // Pool funds only 1 seat, so the (floored) guarantee of 2 is what rules.
    const p = planSatelliteAwards({
      pool: 300,
      ticketCost: TICKET,
      configuredSeats: 2.9,
      finisherCount: 10,
    });
    expect(p.awardCount).toBe(2);
  });
});

describe('the remainder recipient is why it needs its own idempotency key', () => {
  it('resolves to a player ALREADY PAID when the seats exhausted the field', () => {
    /* The caller pays seat winners under `prize:{user}:{position}`. On a short
       field the remainder goes to the LAST seat winner - who already has a
       row under that key. Reusing it would dedupe the remainder into nothing
       instead of deduping a double payment, which is why the caller uses a
       separate `satremainder:` namespace. */
    const p = planSatelliteAwards({
      pool: 1000,
      ticketCost: TICKET,
      configuredSeats: 0,
      finisherCount: 4,
    });
    expect(p.awardCount).toBe(4); // floor(1000/200)=5, capped by 4 finishers
    expect(p.remainder).toBe(200);
    expect(remainderRecipientIndex(p, 4)).toBe(3); // the last seat winner
  });

  it('resolves to a fresh player whenever the field is long enough', () => {
    // 2026-08-30 floor-not-cap: 1,050 funds 5 seats over a 4-seat guarantee,
    // and the 50 left over goes to 6th - the first player without a seat.
    const p = planSatelliteAwards({
      pool: 1050,
      ticketCost: TICKET,
      configuredSeats: 4,
      finisherCount: 30,
    });
    expect(p.awardCount).toBe(5);
    expect(p.remainder).toBe(50);
    expect(remainderRecipientIndex(p, 30)).toBe(5);
    expect(remainderRecipientIndex(p, 30)).toBeGreaterThanOrEqual(p.awardCount);
  });
});

describe('the guarantee is a floor, not a cap (2026-08-30)', () => {
  it('a field that out-funds the guarantee gets the extra seats, not cash', () => {
    // "2 Seats Guaranteed" but 1,000 collected at 200 a seat -> 5 seats.
    const p = planSatelliteAwards({
      pool: 1000,
      ticketCost: 200,
      configuredSeats: 2,
      finisherCount: 20,
    });
    expect(p.awardCount).toBe(5);
    expect(p.remainder).toBe(0);
    expect(p.overlay).toBe(0);
  });

  it('the fractional surplus above the funded seats is still cash to the next finisher', () => {
    const p = planSatelliteAwards({
      pool: 1050,
      ticketCost: 200,
      configuredSeats: 2,
      finisherCount: 20,
    });
    expect(p.awardCount).toBe(5);
    expect(p.remainder).toBe(50);
  });

  it('an under-funded guarantee still wins - the floor holds from below', () => {
    const p = planSatelliteAwards({
      pool: 540,
      ticketCost: 200,
      configuredSeats: 3,
      finisherCount: 20,
    });
    expect(p.awardCount).toBe(3);
    expect(p.overlay).toBe(60);
    expect(p.remainder).toBe(0);
  });
});
