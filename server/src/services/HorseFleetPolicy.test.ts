/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FLEET POLICY IS A CEILING, NEVER AN EVICTION - Phase 3
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PHASE3-CONTRACTS section 0, binding: "THE FLEET KEEPS RUNNING EXACTLY AS IT
 * DOES TODAY UNTIL A POLICY ROW SAYS OTHERWISE, AND NO CONTROL MAY REACH
 * INSIDE A HAND."
 *
 * Two things are pinned here, and they are the two that would hurt if they
 * drifted:
 *
 *  1. THE DEFAULTS ARE TODAY. Every field of FLEET_POLICY_DEFAULTS is the
 *     value that reproduces the engine's behaviour before this module existed,
 *     and every failure path lands on them. A read that errors, throws,
 *     returns nothing, or returns nonsense must leave the floor exactly as it
 *     was - the opposite failure is the one this codebase has already paid for
 *     twice (the bankroll gate that read an unknown roll as zero and emptied
 *     the cash floor for forty minutes on 2026-08-31, and the truncated table
 *     list that starved 134 tables on 2026-09-02).
 *
 *  2. NOTHING HERE CAN REMOVE ANYBODY. `capBySeatedCount` returns a count of
 *     seats to ADD and can never go below zero, whatever an operator sets and
 *     whoever is already sitting there. A cap lowered under a live game seats
 *     nobody else; it does not stand anybody up. HORSES ARE PLAYERS
 *     (CLAUDE.md 10.5), so there is no eviction path to write in the first
 *     place.
 *
 * The helpers are pure by design so both this file and HorseFleetManager read
 * the SAME arithmetic. Two copies of one number is the shape of bug this
 * codebase keeps paying for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/* The client and the reporter are the module's only two dependencies, and
   both are replaced rather than exercised: creating the real service-role
   client needs credentials this runner deliberately does not have. `vi.mock`
   is hoisted above the imports, so the doubles are built inside `vi.hoisted`
   rather than as plain consts - a const referenced from a hoisted factory is
   still in its temporal dead zone when the factory runs. */
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  reported: [] as Array<{ context: string }>,
}));

vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: h.rpc },
}));

vi.mock('./errorReporter.js', () => ({
  reportError: (_err: unknown, context: string) => {
    h.reported.push({ context });
  },
}));

import {
  FLEET_POLICY_DEFAULTS,
  _resetFleetPolicyCacheForTests,
  applyBias,
  capBySeatedCount,
  getFleetPolicy,
  horseAllowedByPolicy,
  seatingAllowedNow,
  withheldReason,
  type FleetPolicy,
} from './HorseFleetPolicy.js';

/** A policy that differs from today in exactly the ways a test names. */
function policy(over: Partial<FleetPolicy> = {}): FleetPolicy {
  return { ...FLEET_POLICY_DEFAULTS, ...over };
}

const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i);

beforeEach(() => {
  _resetFleetPolicyCacheForTests();
  h.rpc.mockReset();
  h.reported.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════

describe('the defaults are today, written down', () => {
  it('is every field, at the value that changes nothing', () => {
    expect(FLEET_POLICY_DEFAULTS).toEqual({
      enabled: true,
      pauseNewSeatings: false,
      maxHorses: null,
      maxPerTable: null,
      occupancyBias: 1.0,
      minHumansToSeat: 0,
      stakeBands: null,
      variants: null,
      schedule: null,
      degraded: false,
      version: null,
      source: null,
    });
  });

  it('withholds nothing, anywhere, at any hour', () => {
    for (const hour of ALL_HOURS) {
      expect(
        withheldReason(policy(), {
          nowUTCHour: hour,
          seatedHorses: 10_000,
          seatedAtTable: 9,
          humansAtTable: 0,
          stakeBand: 'micro',
          variant: 'plo6',
        })
      ).toBeNull();
    }
  });

  it('cannot be mutated by a caller, so one bad write cannot outlive a cycle', () => {
    // Every failed read hands out the SAME object graph. A caller that wrote
    // to it would change the fallback for the life of the process.
    expect(Object.isFrozen(FLEET_POLICY_DEFAULTS)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BIAS
// ═══════════════════════════════════════════════════════════════════════════

describe('occupancy bias scales the target and is clamped at both ends', () => {
  it('changes nothing at 1.0 - the default, and what an absent policy returns', () => {
    for (let target = 1; target <= 9; target++) {
      expect(applyBias(target, FLEET_POLICY_DEFAULTS.occupancyBias, 9)).toBe(target);
    }
  });

  it('scales up and down in between', () => {
    expect(applyBias(4, 2, 9)).toBe(8);
    expect(applyBias(8, 0.5, 9)).toBe(4);
    expect(applyBias(6, 0.5, 9)).toBe(3);
  });

  it('rounds half up, the direction that keeps a game playable', () => {
    expect(applyBias(9, 0.5, 9)).toBe(5);
    expect(applyBias(3, 0.5, 9)).toBe(2);
  });

  it('never takes a table below one seat, whatever the bias', () => {
    /* Dan's floor for the sparse quarter is ONE (HorseOccupancy.test.ts: "it
       never leaves a table with nobody at it"). A bias is not allowed to
       reintroduce the held-empty rule that floor replaced. */
    expect(applyBias(9, 0, 9)).toBe(1);
    expect(applyBias(9, 0.001, 9)).toBe(1);
    expect(applyBias(1, 0.5, 9)).toBe(1);
    for (const bias of [0, 0.01, 0.1, 0.25, 0.5, 0.9]) {
      for (let target = 1; target <= 9; target++) {
        expect(applyBias(target, bias, 9)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('never conjures a seat the table does not have', () => {
    expect(applyBias(9, 2, 9)).toBe(9);
    expect(applyBias(5, 4, 6)).toBe(6);
    for (const bias of [1.1, 2, 10, 1000]) {
      for (let target = 1; target <= 9; target++) {
        expect(applyBias(target, bias, 9)).toBeLessThanOrEqual(9);
        expect(applyBias(target, bias, 6)).toBeLessThanOrEqual(6);
      }
    }
  });

  it('treats an unreadable bias as no opinion rather than as zero', () => {
    // Bad data must not resize a table. This is the same doctrine as the
    // bankroll gate: unknown is unknown, never zero.
    expect(applyBias(9, Number.NaN, 9)).toBe(9);
    expect(applyBias(9, -1, 9)).toBe(9);
    expect(applyBias(9, Number.POSITIVE_INFINITY, 9)).toBe(9);
  });

  it('survives a nonsense seat count without returning zero seats', () => {
    expect(applyBias(9, 1, 0)).toBe(1);
    expect(applyBias(9, 1, Number.NaN)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PER TABLE CAP
// ═══════════════════════════════════════════════════════════════════════════

describe('the per-table cap is arithmetic that cannot evict', () => {
  it('with no cap it is the subtraction the seeding loop already did', () => {
    expect(capBySeatedCount(9, 0, null)).toBe(9);
    expect(capBySeatedCount(9, 4, null)).toBe(5);
    expect(capBySeatedCount(6, 6, null)).toBe(0);
    for (let target = 0; target <= 9; target++) {
      for (let seated = 0; seated <= 9; seated++) {
        expect(capBySeatedCount(target, seated, null)).toBe(Math.max(0, target - seated));
      }
    }
  });

  it('caps the target at the operator number', () => {
    expect(capBySeatedCount(9, 0, 5)).toBe(5);
    expect(capBySeatedCount(9, 2, 5)).toBe(3);
    expect(capBySeatedCount(3, 0, 5)).toBe(3); // a lower target still wins
  });

  it('seats nobody once the cap is reached', () => {
    expect(capBySeatedCount(9, 5, 5)).toBe(0);
    expect(capBySeatedCount(9, 0, 0)).toBe(0);
  });

  it('NEVER returns a negative number, however far over the cap a table is', () => {
    /* An operator lowering a cap under a live game is ordinary. The answer is
       "seat nobody else", and there is no value this function can return that
       a caller could read as "stand somebody up". */
    expect(capBySeatedCount(9, 7, 5)).toBe(0);
    expect(capBySeatedCount(9, 9, 1)).toBe(0);
    expect(capBySeatedCount(0, 9, 0)).toBe(0);
    for (let seated = 0; seated <= 12; seated++) {
      for (const cap of [0, 1, 2, 5, 9]) {
        expect(capBySeatedCount(9, seated, cap)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('a cap of N never lets a table hold N+1', () => {
    for (const cap of [0, 1, 2, 3, 5, 8, 9]) {
      for (let seated = 0; seated <= 9; seated++) {
        for (let target = 0; target <= 9; target++) {
          const after = seated + capBySeatedCount(target, seated, cap);
          // Never above the cap, and never below what is already seated.
          expect(after).toBeLessThanOrEqual(Math.max(cap, seated));
          expect(after).toBeGreaterThanOrEqual(seated);
        }
      }
    }
  });

  it('survives unreadable counts without inventing seats', () => {
    expect(capBySeatedCount(Number.NaN, 0, null)).toBe(0);
    expect(capBySeatedCount(9, Number.NaN, null)).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════

describe('the schedule narrows WHEN seating happens', () => {
  it('with no schedule, every hour is a seating hour', () => {
    for (const hour of ALL_HOURS) expect(seatingAllowedNow(policy(), hour)).toBe(true);
  });

  it('an empty schedule is no schedule, not a lockout', () => {
    for (const hour of ALL_HOURS) {
      expect(seatingAllowedNow(policy({ schedule: [] }), hour)).toBe(true);
    }
  });

  it('honours a plain window, with the end hour EXCLUSIVE', () => {
    const p = policy({ schedule: [{ startHourUTC: 8, endHourUTC: 12 }] });
    expect(seatingAllowedNow(p, 8)).toBe(true);
    expect(seatingAllowedNow(p, 11)).toBe(true);
    expect(seatingAllowedNow(p, 12)).toBe(false);
    expect(seatingAllowedNow(p, 7)).toBe(false);
    expect(ALL_HOURS.filter((hr) => seatingAllowedNow(p, hr))).toEqual([8, 9, 10, 11]);
  });

  it('WRAPS MIDNIGHT when the end is not after the start', () => {
    /* 22 to 2 is the late-night window an operator means, not an empty set.
       Reading it as empty would silently switch the fleet off for a whole day
       and look like a bug in the engine rather than in the row. */
    const p = policy({ schedule: [{ startHourUTC: 22, endHourUTC: 2 }] });
    expect(ALL_HOURS.filter((hr) => seatingAllowedNow(p, hr))).toEqual([0, 1, 22, 23]);
  });

  it('tiles adjacent windows without a gap or an overlap', () => {
    const p = policy({
      schedule: [
        { startHourUTC: 0, endHourUTC: 8 },
        { startHourUTC: 8, endHourUTC: 16 },
      ],
    });
    expect(ALL_HOURS.filter((hr) => seatingAllowedNow(p, hr))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('reads 0 to 24 as the whole day', () => {
    const p = policy({ schedule: [{ startHourUTC: 0, endHourUTC: 24 }] });
    for (const hour of ALL_HOURS) expect(seatingAllowedNow(p, hour)).toBe(true);
  });

  it('reads equal ends as the whole day, the reading that keeps the floor running', () => {
    const p = policy({ schedule: [{ startHourUTC: 5, endHourUTC: 5 }] });
    for (const hour of ALL_HOURS) expect(seatingAllowedNow(p, hour)).toBe(true);
  });

  it('fails open on an hour it cannot read', () => {
    const p = policy({ schedule: [{ startHourUTC: 8, endHourUTC: 12 }] });
    expect(seatingAllowedNow(p, Number.NaN)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BAND AND VARIANT
// ═══════════════════════════════════════════════════════════════════════════

describe('bands and variants narrow WHICH games are seeded', () => {
  it('allows everything when neither list is set', () => {
    expect(horseAllowedByPolicy(policy(), { stakeBand: 'high', variant: 'plo8' })).toBe(true);
    expect(horseAllowedByPolicy(policy(), { stakeBand: null, variant: null })).toBe(true);
    expect(horseAllowedByPolicy(policy(), {})).toBe(true);
  });

  it('keeps only the named bands', () => {
    const p = policy({ stakeBands: ['low', 'mid'] });
    expect(horseAllowedByPolicy(p, { stakeBand: 'low' })).toBe(true);
    expect(horseAllowedByPolicy(p, { stakeBand: 'mid' })).toBe(true);
    expect(horseAllowedByPolicy(p, { stakeBand: 'micro' })).toBe(false);
    expect(horseAllowedByPolicy(p, { stakeBand: 'high' })).toBe(false);
  });

  it('keeps only the named variants', () => {
    const p = policy({ variants: ['nlh', 'plo4'] });
    expect(horseAllowedByPolicy(p, { variant: 'nlh' })).toBe(true);
    expect(horseAllowedByPolicy(p, { variant: 'plo4' })).toBe(true);
    expect(horseAllowedByPolicy(p, { variant: 'short_deck' })).toBe(false);
  });

  it('requires BOTH lists to pass when both are set', () => {
    const p = policy({ stakeBands: ['low'], variants: ['nlh'] });
    expect(horseAllowedByPolicy(p, { stakeBand: 'low', variant: 'nlh' })).toBe(true);
    expect(horseAllowedByPolicy(p, { stakeBand: 'low', variant: 'plo5' })).toBe(false);
    expect(horseAllowedByPolicy(p, { stakeBand: 'mid', variant: 'nlh' })).toBe(false);
  });

  it('cannot say a value it was never given is allowed', () => {
    const p = policy({ stakeBands: ['low'] });
    expect(horseAllowedByPolicy(p, { stakeBand: null })).toBe(false);
    expect(horseAllowedByPolicy(p, {})).toBe(false);
  });

  it('is not defeated by casing or stray whitespace in a console row', () => {
    const p = policy({ stakeBands: ['low'], variants: ['nlh'] });
    expect(horseAllowedByPolicy(p, { stakeBand: ' LOW ', variant: 'NLH' })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE REASON
// ═══════════════════════════════════════════════════════════════════════════

describe('withheldReason names every cause, in the contract order', () => {
  const full = {
    nowUTCHour: 12,
    seatedHorses: 5,
    seatedAtTable: 3,
    humansAtTable: 1,
    stakeBand: 'low',
    variant: 'nlh',
  };

  it('says nothing when nothing is withholding seating', () => {
    expect(withheldReason(policy(), full)).toBeNull();
  });

  it('the kill switch', () => {
    expect(withheldReason(policy({ enabled: false }), full)).toBe('fleet_disabled');
  });

  it('the pause', () => {
    expect(withheldReason(policy({ pauseNewSeatings: true }), full)).toBe('seating_paused');
  });

  it('the fleet-wide cap, only once it is actually reached', () => {
    expect(withheldReason(policy({ maxHorses: 5 }), full)).toBe('max_horses_reached');
    expect(withheldReason(policy({ maxHorses: 6 }), full)).toBeNull();
  });

  it('the per-table cap, only once it is actually reached', () => {
    expect(withheldReason(policy({ maxPerTable: 3 }), full)).toBe('max_per_table_reached');
    expect(withheldReason(policy({ maxPerTable: 4 }), full)).toBeNull();
  });

  it('too few humans at the table', () => {
    expect(withheldReason(policy({ minHumansToSeat: 2 }), full)).toBe('below_min_humans');
    expect(withheldReason(policy({ minHumansToSeat: 1 }), full)).toBeNull();
  });

  it('the wrong band', () => {
    expect(withheldReason(policy({ stakeBands: ['high'] }), full)).toBe('stake_band_excluded');
  });

  it('the wrong variant', () => {
    expect(withheldReason(policy({ variants: ['plo6'] }), full)).toBe('variant_excluded');
  });

  it('the wrong hour', () => {
    const p = policy({ schedule: [{ startHourUTC: 0, endHourUTC: 6 }] });
    expect(withheldReason(p, full)).toBe('outside_schedule');
    expect(withheldReason(p, { ...full, nowUTCHour: 3 })).toBeNull();
  });

  it('reports the FIRST cause, so an operator is told what they actually did', () => {
    const p = policy({
      enabled: false,
      pauseNewSeatings: true,
      maxHorses: 1,
      schedule: [{ startHourUTC: 0, endHourUTC: 1 }],
    });
    expect(withheldReason(p, full)).toBe('fleet_disabled');
    expect(withheldReason({ ...p, enabled: true }, full)).toBe('seating_paused');
  });

  it('skips a cause the caller cannot answer, rather than guessing at it', () => {
    /* The cycle asks with the hour and the fleet-wide count; one table asks
       with its own occupancy. Neither should be judged on a number it never
       supplied. */
    expect(withheldReason(policy({ maxPerTable: 1 }), { nowUTCHour: 12 })).toBeNull();
    expect(withheldReason(policy({ minHumansToSeat: 4 }), { nowUTCHour: 12 })).toBeNull();
    expect(withheldReason(policy({ stakeBands: ['high'] }), { nowUTCHour: 12 })).toBeNull();
    expect(withheldReason(policy({ maxHorses: 1 }), {})).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE READ
// ═══════════════════════════════════════════════════════════════════════════

describe('reading the policy', () => {
  it('parses a full row from the RPC', async () => {
    h.rpc.mockResolvedValue({
      data: {
        enabled: false,
        pause_new_seatings: true,
        max_horses: 120,
        max_per_table: 4,
        occupancy_bias: 0.5,
        min_humans_to_seat: 2,
        stake_bands: ['LOW', 'mid'],
        variants: ['nlh'],
        schedule: [{ start: 22, end: 2 }],
        updated_at: '2026-09-03T00:00:00Z',
        source: { enabled: 'club' },
      },
      error: null,
    });
    const p = await getFleetPolicy('club-1');
    expect(h.rpc).toHaveBeenCalledWith('fn_ca_fleet_policy_effective', { p_club_id: 'club-1' });
    expect(p.enabled).toBe(false);
    expect(p.pauseNewSeatings).toBe(true);
    expect(p.maxHorses).toBe(120);
    expect(p.maxPerTable).toBe(4);
    expect(p.occupancyBias).toBe(0.5);
    expect(p.minHumansToSeat).toBe(2);
    expect(p.stakeBands).toEqual(['low', 'mid']);
    expect(p.variants).toEqual(['nlh']);
    expect(p.schedule).toEqual([{ startHourUTC: 22, endHourUTC: 2 }]);
    expect(p.version).toBe('2026-09-03T00:00:00Z');
    expect(p.source).toEqual({ enabled: 'club' });
    expect(p.degraded).toBe(false);
  });

  it('accepts every spelling a jsonb schedule can arrive in', async () => {
    h.rpc.mockResolvedValue({
      data: {
        schedule: [
          [1, 2],
          { start_hour_utc: 3, end_hour_utc: 4 },
          { startHourUTC: 5, endHourUTC: 6 },
          { from: 7, to: 8 },
          { nonsense: true },
        ],
      },
      error: null,
    });
    const p = await getFleetPolicy(null);
    expect(p.schedule).toEqual([
      { startHourUTC: 1, endHourUTC: 2 },
      { startHourUTC: 3, endHourUTC: 4 },
      { startHourUTC: 5, endHourUTC: 6 },
      { startHourUTC: 7, endHourUTC: 8 },
    ]);
  });

  it('treats NO POLICY ROW as today, and does not call that degraded', async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    const p = await getFleetPolicy(null);
    expect(p).toEqual({ ...FLEET_POLICY_DEFAULTS });
    expect(p.degraded).toBe(false);
  });

  it('treats a partial row as today for every field it does not carry', async () => {
    h.rpc.mockResolvedValue({ data: { max_per_table: 6 }, error: null });
    const p = await getFleetPolicy(null);
    expect(p.maxPerTable).toBe(6);
    expect(p.enabled).toBe(true);
    expect(p.occupancyBias).toBe(1.0);
    expect(p.minHumansToSeat).toBe(0);
    expect(p.stakeBands).toBeNull();
    expect(p.schedule).toBeNull();
  });

  it('reads an EMPTY list as no restriction, never as a kill switch', async () => {
    /* NULL is the column's no-restriction value, so an empty array reaches
       here from a console form where nothing was ticked. Reading it as "no
       band is eligible" would stop the whole floor by accident, and the kill
       switch is `enabled` - the only thing that should ever read like one. */
    h.rpc.mockResolvedValue({ data: { stake_bands: [], variants: [] }, error: null });
    const p = await getFleetPolicy(null);
    expect(p.stakeBands).toBeNull();
    expect(p.variants).toBeNull();
  });

  it('ignores a negative cap rather than seating nobody on bad data', async () => {
    h.rpc.mockResolvedValue({ data: { max_horses: -5, occupancy_bias: -2 }, error: null });
    const p = await getFleetPolicy(null);
    expect(p.maxHorses).toBeNull();
    expect(p.occupancyBias).toBe(1.0);
  });

  it('USES THE DEFAULTS AND SAYS SO when the read fails', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const p = await getFleetPolicy(null);
    expect(p).toEqual({ ...FLEET_POLICY_DEFAULTS, degraded: true });
    expect(p.degraded).toBe(true);
    expect(h.reported.map((r: { context: string }) => r.context)).toContain(
      'HorseFleetPolicy.policy_read_failed'
    );
  });

  it('uses the defaults when the call throws outright', async () => {
    h.rpc.mockRejectedValue(new Error('socket hang up'));
    const p = await getFleetPolicy(null);
    expect(p.enabled).toBe(true);
    expect(p.degraded).toBe(true);
  });

  it('never throws and never returns null, whatever comes back', async () => {
    for (const answer of [undefined, null, {}, { data: 'nonsense', error: null }, 42]) {
      h.rpc.mockResolvedValue(answer as never);
      _resetFleetPolicyCacheForTests();
      const p = await getFleetPolicy(null);
      expect(p).toBeTruthy();
      expect(p.enabled).toBe(true);
      expect(p.occupancyBias).toBe(1.0);
    }
  });

  it('caches for the cycle, so a floor of a thousand tables is one read', async () => {
    h.rpc.mockResolvedValue({ data: { max_per_table: 3 }, error: null });
    await getFleetPolicy('club-1');
    await getFleetPolicy('club-1');
    await getFleetPolicy('club-1');
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('caches per club scope, so one club cannot answer for another', async () => {
    h.rpc.mockResolvedValue({ data: { max_per_table: 3 }, error: null });
    await getFleetPolicy(null);
    await getFleetPolicy('club-1');
    await getFleetPolicy('club-2');
    expect(h.rpc).toHaveBeenCalledTimes(3);
    expect(h.rpc).toHaveBeenCalledWith('fn_ca_fleet_policy_effective', { p_club_id: null });
  });

  it('does NOT cache a failure, so the fleet comes back under management fast', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await getFleetPolicy(null)).degraded).toBe(true);
    h.rpc.mockResolvedValue({ data: { enabled: false }, error: null });
    const second = await getFleetPolicy(null);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(second.enabled).toBe(false);
    expect(second.degraded).toBe(false);
  });

  it('reports a repeated failure once, not once every thirty seconds', async () => {
    /* The engine can ship before the migration that creates the RPC. An
       unthrottled report would file a error reporting event every cycle for ever,
       which is how a real signal becomes noise. */
    h.rpc.mockResolvedValue({ data: null, error: { message: 'PGRST202' } });
    await getFleetPolicy(null);
    await getFleetPolicy(null);
    await getFleetPolicy(null);
    expect(h.rpc).toHaveBeenCalledTimes(3);
    expect(h.reported.length).toBe(1);
  });
});
