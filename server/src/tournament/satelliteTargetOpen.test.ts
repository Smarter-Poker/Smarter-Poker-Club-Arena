/**
 * A SATELLITE MAY NEVER PAY OUT MORE THAN IT COLLECTED.
 *
 * Every case here is taken from production on 2026-08-30, where fifteen
 * completed satellites collected 3,325.50 and paid out 6,908.00, and ten of
 * thirty-nine seat winners were never entered into the event they had just
 * won a seat in.
 */
import { describe, it, expect } from 'vitest';
import { isSatelliteTargetOpen, satelliteTicketCost } from './satelliteTargetOpen.js';
import { planSatelliteAwards } from './satelliteAwardPlan.js';

const RUNNING_IN_LATE_REG = {
  status: 'RUNNING',
  current_level: 6,
  late_reg_levels: 12,
  rebuy_levels: 12,
  current_players: 109,
  max_players: 1000,
};

describe('a running target is open while late registration is', () => {
  it('is open at level 6 of 12 - the live Sunday $200 Deep Stack', () => {
    expect(isSatelliteTargetOpen(RUNNING_IN_LATE_REG)).toBe(true);
  });

  /**
   * THE CAP IS AN EXCLUSIVE BOUND ON A ZERO-BASED INDEX (corrected 2026-08-31).
   *
   * This test used to assert index 12 open and index 13 closed against a cap of
   * 12 — one level too generous, because `current_level` indexes
   * `blind_structure` directly, so a cap of 12 covers indices 0..11 and index
   * 12 is the first level of the closed event. Every other reader in the
   * codebase closes on `>=`: fn_register_for_tournament,
   * process_tournament_rebuy, TournamentManagerBase.isLateRegClosed,
   * TournamentInfoPanel.tsx:216 and TournamentDetails.tsx. This gate and
   * fn_award_satellite_seat were the only two that did not, and a satellite
   * winner could be seated into an event that had been refusing direct
   * buy-ins for a whole level.
   */
  it('is open on the last late-reg level index, and closed at the cap itself', () => {
    expect(isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, current_level: 11 })).toBe(true);
    expect(isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, current_level: 12 })).toBe(false);
    expect(isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, current_level: 13 })).toBe(false);
  });

  it('closes on a finalized prize pool whatever the level says', () => {
    // The payout ladder has been sized against the pool as it stands; a seat
    // sold now adds a buy-in the ladder was not built from.
    expect(isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, prize_pool_finalized: true })).toBe(
      false
    );
    expect(isSatelliteTargetOpen({ status: 'REGISTERING', prize_pool_finalized: true })).toBe(
      false
    );
    // ...and an unset / false flag changes nothing.
    expect(isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, prize_pool_finalized: false })).toBe(
      true
    );
    expect(isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, prize_pool_finalized: null })).toBe(
      true
    );
  });

  it('falls back to rebuy_levels when late_reg_levels is unset, as the rest of the code does', () => {
    expect(
      isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, late_reg_levels: null, rebuy_levels: 12 })
    ).toBe(true);
  });

  it('is closed when a running target has no late registration at all', () => {
    expect(
      isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, late_reg_levels: 0, rebuy_levels: 0 })
    ).toBe(false);
  });

  it('still accepts a target that has not started', () => {
    expect(isSatelliteTargetOpen({ status: 'REGISTERING' })).toBe(true);
    expect(isSatelliteTargetOpen({ status: 'ANNOUNCED' })).toBe(true);
  });

  it('refuses a finished, completing or cancelled target, and a missing one', () => {
    for (const status of ['COMPLETED', 'COMPLETING', 'CANCELLED']) {
      expect(isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, status })).toBe(false);
    }
    expect(isSatelliteTargetOpen(null)).toBe(false);
  });

  it('refuses a full field - seating into no seat is not a favour', () => {
    expect(
      isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, current_players: 1000, max_players: 1000 })
    ).toBe(false);
  });

  it('treats an absent cap as uncapped rather than as full', () => {
    expect(
      isSatelliteTargetOpen({ ...RUNNING_IN_LATE_REG, max_players: null, current_players: 5000 })
    ).toBe(true);
  });
});

describe('a ticket that cannot be spent is worth nothing', () => {
  const target = { buy_in_amount: 180, buy_in_fee: 20 };

  it('is worth buy-in plus fee when the seat can be awarded', () => {
    expect(satelliteTicketCost(target, true)).toBe(200);
  });

  it('is worth zero when it cannot - the row existing is not the test', () => {
    expect(satelliteTicketCost(target, false)).toBe(0);
    expect(satelliteTicketCost(null, true)).toBe(0);
  });
});

describe('the pool bounds the payout (the 2026-08-30 leak)', () => {
  /**
   * The exact production numbers. A $25 satellite, 540 collected, five seats
   * advertised, target RUNNING. It paid five tickets at 200 = 1,000 in CASH.
   */
  it('no longer invents 460 chips when the target is closed', () => {
    const ticketCost = satelliteTicketCost({ buy_in_amount: 180, buy_in_fee: 20 }, false);
    const plan = planSatelliteAwards({
      pool: 540,
      ticketCost,
      configuredSeats: 5,
      finisherCount: 50,
    });
    expect(plan.awardCount).toBe(0);
    expect(plan.cashWholePoolToFirst).toBe(true);
    // Everything paid comes out of the pool, and nothing beyond it.
    expect(plan.awardCount * plan.ticketCost + plan.remainder).toBeLessThanOrEqual(540);
  });

  it('the worst observed case: a 108 pool paid 1,000 and now cannot', () => {
    const ticketCost = satelliteTicketCost({ buy_in_amount: 180, buy_in_fee: 20 }, false);
    const plan = planSatelliteAwards({
      pool: 108,
      ticketCost,
      configuredSeats: 5,
      finisherCount: 50,
    });
    expect(plan.awardCount * plan.ticketCost).toBe(0);
    expect(plan.cashWholePoolToFirst).toBe(true);
  });

  it('an OPEN target still awards the seats, overlay and all - that is the promise', () => {
    // The deliberate exposure is untouched: 5 real entries into the target,
    // funded by tickets, with the house covering the 460 difference.
    const ticketCost = satelliteTicketCost({ buy_in_amount: 180, buy_in_fee: 20 }, true);
    const plan = planSatelliteAwards({
      pool: 540,
      ticketCost,
      configuredSeats: 5,
      finisherCount: 50,
    });
    expect(plan.awardCount).toBe(5);
    expect(plan.ticketCost).toBe(200);
    expect(plan.overlay).toBe(460);
  });

  it('end to end: the live satellite seats its winners instead of cashing them', () => {
    const target = { ...RUNNING_IN_LATE_REG, buy_in_amount: 180, buy_in_fee: 20 };
    const open = isSatelliteTargetOpen(target);
    const plan = planSatelliteAwards({
      pool: 540,
      ticketCost: satelliteTicketCost(target, open),
      configuredSeats: 5,
      finisherCount: 50,
    });
    expect(open).toBe(true);
    expect(plan.awardCount).toBe(5);
  });
});

describe('minutes-only admission matches the database deadline', () => {
  const start = Date.parse('2026-09-08T14:00:00Z');
  const target = {
    status: 'RUNNING',
    late_reg_levels: 0,
    rebuy_levels: 0,
    late_reg_mins: 10,
    started_at: new Date(start).toISOString(),
  };
  it('opens before the deadline and closes exactly at it', () => {
    expect(isSatelliteTargetOpen(target, start + 599999)).toBe(true);
    expect(isSatelliteTargetOpen(target, start + 600000)).toBe(false);
    expect(isSatelliteTargetOpen(target, start + 600001)).toBe(false);
  });
  it('keeps a positive level cap authoritative over the minutes window', () => {
    expect(isSatelliteTargetOpen({ ...target, late_reg_levels: 5, current_level: 5 }, start)).toBe(
      false
    );
    expect(
      isSatelliteTargetOpen({ ...target, late_reg_levels: 5, current_level: 4 }, start + 600001)
    ).toBe(true);
    expect(
      isSatelliteTargetOpen(
        { ...target, late_reg_levels: null, rebuy_levels: 5, current_level: 5 },
        start
      )
    ).toBe(false);
  });
  it('keeps finalized pools and full targets closed', () => {
    expect(isSatelliteTargetOpen({ ...target, prize_pool_finalized: true }, start)).toBe(false);
    expect(isSatelliteTargetOpen({ ...target, max_players: 2, current_players: 2 }, start)).toBe(
      false
    );
  });
  it('cannot infer a timed opening without a valid start and duration', () => {
    for (const started_at of [null, '', 'invalid'])
      expect(isSatelliteTargetOpen({ ...target, started_at }, start)).toBe(false);
    for (const late_reg_mins of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isSatelliteTargetOpen({ ...target, late_reg_mins }, start)).toBe(false);
  });
});
