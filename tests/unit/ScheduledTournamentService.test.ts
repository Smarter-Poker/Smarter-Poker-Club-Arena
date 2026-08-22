/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ScheduledTournamentService (data-driven recurring MTTs)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The scheduling rules are pure functions exported from the service precisely
 * so they can be pinned here with no DB in the room:
 *
 *   - timedSpawnsDue: UTC day/time matching + the [-5min, +30min] spawn window,
 *     midnight-crossing included, and the deterministic spawn key that the
 *     tournament_schedule_spawns UNIQUE constraint dedupes on.
 *   - intervalRespawnDue: one live instance per schedule; respawn only
 *     interval_minutes after the previous instance ended; ambiguity fails
 *     closed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock the server-side supabase module (needs env vars at load time) ────
vi.mock('../../server/src/services/supabase.js', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      channel: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
      }),
    },
  };
});

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  ScheduledTournamentService,
  timedSpawnsDue,
  intervalRespawnDue,
  intervalSpawnKey,
  TIMED_WINDOW_AHEAD_MS,
  TIMED_WINDOW_PAST_MS,
} from '../../server/src/services/ScheduledTournamentService';

// 2026-01-04 is a Sunday (UTC day 0); 2026-01-05 a Monday (day 1).
const SUNDAY = (h: number, m: number) => new Date(Date.UTC(2026, 0, 4, h, m, 0));
const SCHEDULE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff';

describe('timedSpawnsDue — day/time matching and the spawn window', () => {
  const sched = (days: number[], times: string[]) => ({
    id: SCHEDULE_ID,
    days_of_week: days,
    start_times_utc: times,
  });

  it('spawns a time within the 30-minute look-ahead on a scheduled day', () => {
    const due = timedSpawnsDue(sched([0], ['12:15']), SUNDAY(12, 0));
    expect(due).toHaveLength(1);
    expect(due[0].spawnKey).toBe(`${SCHEDULE_ID}:2026-01-04:12:15`);
    expect(due[0].startTime.toISOString()).toBe('2026-01-04T12:15:00.000Z');
  });

  it('does NOT spawn a time beyond the look-ahead window', () => {
    expect(timedSpawnsDue(sched([0], ['12:45']), SUNDAY(12, 0))).toHaveLength(0);
    // Boundary: exactly at the edge is still allowed, one minute past is not.
    expect(TIMED_WINDOW_AHEAD_MS).toBe(30 * 60 * 1000);
  });

  it('catch-up: a start time up to 5 minutes in the past still spawns', () => {
    const due = timedSpawnsDue(sched([0], ['12:00']), SUNDAY(12, 3));
    expect(due).toHaveLength(1);
    expect(due[0].startTime.toISOString()).toBe('2026-01-04T12:00:00.000Z');
    expect(TIMED_WINDOW_PAST_MS).toBe(5 * 60 * 1000);
  });

  it('a start time older than the catch-up window is skipped', () => {
    expect(timedSpawnsDue(sched([0], ['12:00']), SUNDAY(12, 10))).toHaveLength(0);
  });

  it('does not spawn on a day the schedule does not include', () => {
    // Sunday check against a Monday-only schedule.
    expect(timedSpawnsDue(sched([1], ['12:15']), SUNDAY(12, 0))).toHaveLength(0);
  });

  it("crosses midnight forward: Sunday 23:50 sees Monday's 00:10", () => {
    const due = timedSpawnsDue(sched([1], ['00:10']), SUNDAY(23, 50));
    expect(due).toHaveLength(1);
    expect(due[0].spawnKey).toBe(`${SCHEDULE_ID}:2026-01-05:00:10`);
    expect(due[0].startTime.toISOString()).toBe('2026-01-05T00:10:00.000Z');
  });

  it('the spawn key is deterministic — the dedupe contract', () => {
    const a = timedSpawnsDue(sched([0], ['12:15']), SUNDAY(12, 0));
    const b = timedSpawnsDue(sched([0], ['12:15']), SUNDAY(12, 14));
    expect(a[0].spawnKey).toBe(b[0].spawnKey);
  });

  it('malformed times and empty schedules fail closed', () => {
    expect(timedSpawnsDue(sched([0], ['25:99']), SUNDAY(12, 0))).toHaveLength(0);
    expect(timedSpawnsDue(sched([0], []), SUNDAY(12, 0))).toHaveLength(0);
    expect(timedSpawnsDue(sched([], ['12:15']), SUNDAY(12, 0))).toHaveLength(0);
  });
});

describe('intervalRespawnDue — one live instance, respawn after the gap', () => {
  const base = { intervalMinutes: 60, now: SUNDAY(12, 0) };

  it('never respawns while an instance is live', () => {
    expect(
      intervalRespawnDue({ ...base, hasLive: true, everSpawned: true, lastEndedAt: SUNDAY(9, 0) })
    ).toBe(false);
  });

  it('spawns immediately when the schedule has never spawned', () => {
    expect(
      intervalRespawnDue({ ...base, hasLive: false, everSpawned: false, lastEndedAt: null })
    ).toBe(true);
  });

  it('waits out the interval after the previous instance ended', () => {
    expect(
      intervalRespawnDue({ ...base, hasLive: false, everSpawned: true, lastEndedAt: SUNDAY(11, 30) })
    ).toBe(false);
    expect(
      intervalRespawnDue({ ...base, hasLive: false, everSpawned: true, lastEndedAt: SUNDAY(11, 0) })
    ).toBe(true);
  });

  it('an instance with no known end time fails closed', () => {
    expect(
      intervalRespawnDue({ ...base, hasLive: false, everSpawned: true, lastEndedAt: null })
    ).toBe(false);
  });

  it('the interval spawn key is stable within its epoch minute', () => {
    expect(intervalSpawnKey(SCHEDULE_ID, SUNDAY(12, 0))).toBe(
      intervalSpawnKey(SCHEDULE_ID, new Date(SUNDAY(12, 0).getTime() + 30_000))
    );
    expect(intervalSpawnKey(SCHEDULE_ID, SUNDAY(12, 0))).not.toBe(
      intervalSpawnKey(SCHEDULE_ID, SUNDAY(12, 1))
    );
  });
});

describe('ScheduledTournamentService lifecycle', () => {
  let service: ScheduledTournamentService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new ScheduledTournamentService();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('starts, ignores a double start, and stops without crashing', () => {
    service.start();
    service.start();
    service.stop();
    service.stop();
    service.start();
    service.stop();
  });
});
