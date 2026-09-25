/**
 * A schedule keeps its time zone (migration 20260924045822).
 *
 * The case table is shared with scripts/ci/test-schedule-time-zone.py, which
 * checks the same expected instants against PostgreSQL's tz database with the
 * same definition, and then claims the same spawn keys against the real
 * UNIQUE(spawn_key) so a fall-back day and a re-run poll are proven to spawn
 * once. Change a case here and the SQL harness sees it too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localDateIn, zonedStartUtc, isSupportedTimeZone } from './scheduleWallClock.js';
import { timedSpawnsDue } from './ScheduledTournamentService.js';

interface OccurrenceCase {
  name: string;
  zone: string;
  localDate: string;
  time: string;
  utc: string;
}
interface SpawnCase {
  name: string;
  scheduleId: string;
  zone: string | null;
  daysOfWeek: number[];
  times: string[];
  now: string;
  aheadMs: number;
  expect: { spawnKey: string; startTime: string }[];
}
const cases = JSON.parse(
  readFileSync(
    join(process.cwd(), '..', 'scripts/ci/fixtures/schedule-time-zone/cases.json'),
    'utf8'
  )
) as { occurrences: OccurrenceCase[]; spawns: SpawnCase[] };

describe('the one occurrence rule: earliest instant the wall clock reads at or after the local time', () => {
  it.each(cases.occurrences.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(zonedStartUtc(c.localDate, c.time, c.zone).toISOString()).toBe(c.utc);
  });

  it('covers a normal day, the spring gap and the fall overlap in both zones', () => {
    const names = cases.occurrences.map((c) => c.name);
    for (const zone of ['chicago', 'london']) {
      for (const kind of ['normal', 'spring-gap', 'fall-overlap']) {
        expect(names.some((n) => n.startsWith(`${zone}-`) && n.includes(kind))).toBe(true);
      }
    }
  });

  it('a Repeats Weekly 8:00 PM in Chicago stays 8:00 PM local across both changes', () => {
    for (const c of cases.occurrences.filter((o) => o.name.startsWith('chicago-weekly-8pm'))) {
      const at = new Date(c.utc);
      const local = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      }).format(at);
      expect(local).toBe('20:00');
      expect(localDateIn(at, 'America/Chicago')).toBe(c.localDate);
    }
  });

  it('an unknown zone or malformed input throws instead of guessing UTC', () => {
    expect(isSupportedTimeZone('America/Chicago')).toBe(true);
    expect(isSupportedTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(() => zonedStartUtc('2026-01-01', '20:00', 'Mars/Olympus_Mons')).toThrow(RangeError);
    expect(() => zonedStartUtc('2026-01-01', '24:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedStartUtc('2026-1-1', '20:00', 'UTC')).toThrow(RangeError);
  });
});

describe('the engine spawner uses the rule, and a start has one identity', () => {
  it.each(cases.spawns.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const due = timedSpawnsDue(
      {
        id: c.scheduleId,
        days_of_week: c.daysOfWeek,
        start_times_utc: c.times,
        time_zone: c.zone,
      },
      new Date(c.now),
      c.aheadMs
    );
    expect(
      due.map((d) => ({ spawnKey: d.spawnKey, startTime: d.startTime.toISOString() }))
    ).toEqual(c.expect);
  });

  it('every poll across the fall-back hours sees the overlap start under one key', () => {
    const keys = new Set<string>();
    const starts = new Set<string>();
    // Every minute from 00:00 CDT to 02:30 CST on 2026-11-01, both 01:xx readings included.
    for (
      let t = Date.parse('2026-11-01T05:00:00Z');
      t <= Date.parse('2026-11-01T08:30:00Z');
      t += 60_000
    ) {
      for (const d of timedSpawnsDue(
        {
          id: 'overlap',
          days_of_week: [0],
          start_times_utc: ['01:30'],
          time_zone: 'America/Chicago',
        },
        new Date(t)
      )) {
        if (d.localDate === '2026-11-01') {
          keys.add(d.spawnKey);
          starts.add(d.startTime.toISOString());
        }
      }
    }
    expect([...keys]).toEqual(['overlap:2026-11-01:01:30']);
    expect([...starts]).toEqual(['2026-11-01T06:30:00.000Z']);
  });

  it('a NULL zone and an absent zone are the original UTC behaviour, key for key', () => {
    const base = {
      id: 's',
      days_of_week: [0, 1, 2, 3, 4, 5, 6],
      start_times_utc: ['01:30', '20:00'],
    };
    const now = new Date('2026-11-01T00:00:00Z');
    const absent = timedSpawnsDue(base, now);
    const nullZone = timedSpawnsDue({ ...base, time_zone: null }, now);
    expect(nullZone).toEqual(absent);
    expect(absent.map((d) => d.spawnKey)).toContain('s:2026-11-01:01:30');
    expect(absent.find((d) => d.spawnKey === 's:2026-11-01:01:30')?.startTime.toISOString()).toBe(
      '2026-11-01T01:30:00.000Z'
    );
  });

  it('an unknown zone fails the schedule closed rather than spawning at a UTC guess', () => {
    expect(() =>
      timedSpawnsDue(
        { id: 'x', days_of_week: [0], start_times_utc: ['20:00'], time_zone: 'Mars/Olympus_Mons' },
        new Date('2026-11-01T00:00:00Z')
      )
    ).toThrow(RangeError);
  });
});
