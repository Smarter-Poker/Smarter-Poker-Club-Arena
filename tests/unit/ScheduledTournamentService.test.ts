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
  spawnAheadMsFor,
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

  it('spawns a time within the look-ahead on a scheduled day', () => {
    const due = timedSpawnsDue(sched([0], ['12:15']), SUNDAY(12, 0));
    expect(due).toHaveLength(1);
    expect(due[0].spawnKey).toBe(`${SCHEDULE_ID}:2026-01-04:12:15`);
    expect(due[0].startTime.toISOString()).toBe('2026-01-04T12:15:00.000Z');
  });

  it('does NOT spawn a time beyond the look-ahead window', () => {
    // 2026-08-23: the window was widened from 30 minutes to a full day, so
    // the "too far ahead" case has to be measured a day out rather than an
    // hour. WHY it changed: at 30 minutes an event only existed for the half
    // hour before it started, so with 38 live schedules the lobby still read
    // as empty — two joinable MTTs at any given moment. Publishing the card a
    // day ahead is what makes the board look like a real room's.
    //
    // 2026-08-26: widened to 48 hours, then to 72 on Dan's second pass ("USE
    // 72H/6 DAY FOR $200 BUY IN OR MORE"). The lobby cannot list a row the
    // spawner never created, so this constant is the ceiling on the whole
    // board. The out-of-window case moves out with it: FOUR days is now the
    // first clock that is genuinely too far for an ordinary event.
    //
    // Four rather than three deliberately. Three days lands 45 minutes past
    // the boundary, which passes for the right reason today and would flip on
    // any future nudge to the window; four days is unambiguous.
    const fourDaysOut = new Date(SUNDAY(12, 0).getTime() + 96 * 60 * 60 * 1000);
    expect(timedSpawnsDue(sched([fourDaysOut.getUTCDay()], ['12:45']), SUNDAY(12, 0))).toHaveLength(
      0
    );
    expect(TIMED_WINDOW_AHEAD_MS).toBe(72 * 60 * 60 * 1000);
  });

  it('publishes THREE days of a daily schedule, not one (Dan 2026-08-26)', () => {
    // The 72-hour board, measured on the shape that proves it: an event that
    // runs every day is due today, tomorrow and the day after inside the
    // window, and every edition must carry a DIFFERENT spawn key or the
    // dedupe in tournament_schedule_spawns collapses them back into one.
    // This is also the case the (type, name, start_time) unique index had to
    // be widened for - on the old (type, name) key the second and third
    // editions collided and silently never spawned.
    const due = timedSpawnsDue(sched([0, 1, 2, 3, 4, 5, 6], ['12:45']), SUNDAY(12, 0));
    expect(due.length).toBe(3);
    expect(new Set(due.map((d) => d.spawnKey)).size).toBe(3);
  });

  it('a 6 day look-ahead is reserved for buy-ins above 200', () => {
    // "USE 72H/6 DAY FOR $200 BUY IN OR MORE." INCLUSIVE: the first pass read
    // "more then 200" literally and used `>`, which put a flat 200 event on
    // the short window - and the Sunday Deep Stack shipped in the same batch
    // costs exactly 200, so the rule would have excluded the one event it
    // exists for.
    expect(spawnAheadMsFor({ buyIn: 200 })).toBe(6 * 24 * 60 * 60 * 1000);
    expect(spawnAheadMsFor({ buyIn: 199 })).toBe(72 * 60 * 60 * 1000);
    expect(spawnAheadMsFor({})).toBe(72 * 60 * 60 * 1000);
    // An explicit per-schedule override still wins over both (the flagship
    // that opens a week early so its satellites can resolve it).
    expect(spawnAheadMsFor({ buyIn: 5, spawnAheadMinutes: 10080 })).toBe(10080 * 60_000);
    // Out-of-range overrides are ignored rather than honoured.
    expect(spawnAheadMsFor({ buyIn: 5, spawnAheadMinutes: 1 })).toBe(72 * 60 * 60 * 1000);
    expect(spawnAheadMsFor({ buyIn: 5, spawnAheadMinutes: 99999 })).toBe(72 * 60 * 60 * 1000);
  });

  it("tomorrow's daily event is already on the board (the empty-lobby fix)", () => {
    // Same schedule, same clock as the old 30-minute case that saw nothing.
    const due = timedSpawnsDue(sched([0, 1, 2, 3, 4, 5, 6], ['12:45']), SUNDAY(12, 0));
    expect(due.length).toBeGreaterThan(0);
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
    // Sunday check against a THURSDAY-only schedule. This used to say Monday,
    // which stopped being a valid example on 2026-08-26: at a 72-hour
    // look-ahead Monday lunchtime is INSIDE the window when it is Sunday
    // lunchtime, so the assertion was measuring the window rather than the
    // day filter. Thursday is four days out and cannot be confused for either.
    expect(timedSpawnsDue(sched([4], ['12:15']), SUNDAY(12, 0))).toHaveLength(0);
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
      intervalRespawnDue({
        ...base,
        hasLive: false,
        everSpawned: true,
        lastEndedAt: SUNDAY(11, 30),
      })
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
