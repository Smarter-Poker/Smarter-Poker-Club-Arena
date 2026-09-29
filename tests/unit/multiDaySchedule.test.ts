/**
 * The multi-day clock on the client: a start prints in the PLAN's zone, an
 * operator's wall time converts to the right UTC instant across DST, and the
 * Day Schedule refuses what the seal RPC would refuse before anything is
 * created.
 */
import { describe, expect, it } from 'vitest';
import {
  buildStagePlan,
  dayCompleteLabel,
  formatStageStart,
  nextDayStartsLabel,
  utcIsoToZonedWallTime,
  zonedWallTimeToUtcIso,
} from '../../src/utils/multiDaySchedule';

const NOW = Date.parse('2026-10-01T12:00:00Z');

describe('printing a start', () => {
  it('uses the stored zone, not the viewer zone', () => {
    expect(formatStageStart('2026-10-03T17:00:00Z', 'America/Chicago', NOW)).toBe(
      'Sat 12:00 PM CDT'
    );
    expect(nextDayStartsLabel(2, '2026-10-03T17:00:00Z', 'America/Chicago', NOW)).toBe(
      'Day 2 Starts Sat 12:00 PM CDT'
    );
    expect(formatStageStart('2026-10-03T17:00:00Z', 'America/New_York', NOW)).toBe(
      'Sat 1:00 PM EDT'
    );
  });

  it('adds the date when a weekday alone would be ambiguous', () => {
    expect(formatStageStart('2026-11-14T18:00:00Z', 'America/Chicago', NOW)).toBe(
      'Sat Nov 14 12:00 PM CST'
    );
  });

  it('refuses to guess with a bad zone or time', () => {
    expect(formatStageStart('2026-10-03T17:00:00Z', 'Mars/Olympus', NOW)).toBeNull();
    expect(formatStageStart('not a time', 'UTC', NOW)).toBeNull();
    expect(nextDayStartsLabel(2, null, 'UTC', NOW)).toBeNull();
  });

  it('names the day that ended', () => {
    expect(dayCompleteLabel(1)).toBe('Day 1 Complete');
    expect(dayCompleteLabel(null)).toBe('Day Complete');
  });
});

describe('an operator wall time', () => {
  it('converts in the chosen zone, on both sides of a DST change', () => {
    expect(zonedWallTimeToUtcIso('2026-10-03T12:00', 'America/Chicago')).toBe(
      '2026-10-03T17:00:00Z'
    );
    expect(zonedWallTimeToUtcIso('2026-11-14T12:00', 'America/Chicago')).toBe(
      '2026-11-14T18:00:00Z'
    );
    expect(zonedWallTimeToUtcIso('2026-10-03T12:00', 'Europe/Berlin')).toBe('2026-10-03T10:00:00Z');
    expect(zonedWallTimeToUtcIso('2026-10-03T12:00', 'Nowhere/Zone')).toBeNull();
    expect(zonedWallTimeToUtcIso('', 'UTC')).toBeNull();
  });

  it('round-trips for the reschedule field', () => {
    expect(utcIsoToZonedWallTime('2026-10-03T17:00:00Z', 'America/Chicago')).toBe(
      '2026-10-03T12:00'
    );
    expect(utcIsoToZonedWallTime('2026-10-04T05:00:00Z', 'America/Chicago')).toBe(
      '2026-10-04T00:00'
    );
  });
});

describe('the Day Schedule a seal will accept', () => {
  const ctx = { entryLevels: 6, day1StartUtc: '2026-10-02T23:00:00Z', nowMs: NOW };
  const draft = (
    days: Array<{ endAfterLevel: number; startsAtLocal: string }>,
    timeZone = 'America/Chicago'
  ) => ({
    timeZone,
    days,
  });

  it('builds the exact body fn_operator_seal_stage_plan takes', () => {
    const got = buildStagePlan(
      draft([
        { endAfterLevel: 12, startsAtLocal: '' },
        { endAfterLevel: 0, startsAtLocal: '2026-10-03T12:00' },
      ]),
      ctx
    );
    expect(got).toEqual({
      ok: true,
      plan: {
        time_zone: 'America/Chicago',
        stages: [
          { stage_no: 1, end_after_level: 12 },
          { stage_no: 2, scheduled_start_utc: '2026-10-03T17:00:00Z' },
        ],
      },
    });
  });

  it('refuses a Day 1 that ends inside the entry window', () => {
    const got = buildStagePlan(
      draft([
        { endAfterLevel: 6, startsAtLocal: '' },
        { endAfterLevel: 0, startsAtLocal: '2026-10-03T12:00' },
      ]),
      ctx
    );
    expect(got).toEqual({ ok: false, message: 'Day 1 Must End After Level 6, When Entries Close' });
  });

  it('refuses a missing, past or out-of-order start, a non-increasing level, and one day', () => {
    const base = { endAfterLevel: 12, startsAtLocal: '' };
    expect(buildStagePlan(draft([base, { endAfterLevel: 0, startsAtLocal: '' }]), ctx).ok).toBe(
      false
    );
    expect(
      buildStagePlan(draft([base, { endAfterLevel: 0, startsAtLocal: '2026-09-30T12:00' }]), ctx).ok
    ).toBe(false);
    expect(
      buildStagePlan(
        draft([
          base,
          { endAfterLevel: 12, startsAtLocal: '2026-10-03T12:00' },
          { endAfterLevel: 0, startsAtLocal: '2026-10-04T12:00' },
        ]),
        ctx
      )
    ).toEqual({ ok: false, message: 'Day 2 Must End After A Later Level Than The Day Before' });
    expect(
      buildStagePlan(
        draft([
          base,
          { endAfterLevel: 20, startsAtLocal: '2026-10-04T12:00' },
          { endAfterLevel: 0, startsAtLocal: '2026-10-03T12:00' },
        ]),
        ctx
      )
    ).toEqual({ ok: false, message: 'Day 3 Must Start After Day 2' });
    expect(buildStagePlan(draft([base]), ctx).ok).toBe(false);
    expect(buildStagePlan(draft([base, base], 'Mars/Olympus'), ctx).ok).toBe(false);
  });
});
