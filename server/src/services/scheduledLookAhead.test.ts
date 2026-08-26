/**
 * The lobby-is-empty regression (Dan, 2026-08-23).
 *
 * Thirty-eight schedules were live and firing exactly on time, yet the board
 * showed two joinable MTTs, because an event only existed for the 30 minutes
 * before it started. These pin the two rules that fix it: the card is
 * published a day ahead, and horses do not occupy an event until it is about
 * to start.
 */
import { describe, expect, it } from 'vitest';
import {
  timedSpawnsDue,
  TIMED_WINDOW_AHEAD_MS,
  HORSE_SEED_WITHIN_MS,
} from './ScheduledTournamentService.js';
import { MTT_PRESTART_RAMP_MS } from './TournamentRecurringService.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

describe('the card is published a day ahead', () => {
  it('a full day of look-ahead, not half an hour', () => {
    expect(TIMED_WINDOW_AHEAD_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('an 18:00 daily event is on the board the previous evening', () => {
    // 20:00 the night before: the old 30-minute window saw nothing at all.
    const now = new Date('2026-08-22T20:00:00Z');
    const due = timedSpawnsDue(
      { id: 'sched-daily-big', days_of_week: EVERY_DAY, start_times_utc: ['18:00'] },
      now
    );
    expect(due).toHaveLength(1);
    expect(due[0].startTime.toISOString()).toBe('2026-08-23T18:00:00.000Z');
  });

  it('every daily schedule contributes an instance, so the board fills', () => {
    const now = new Date('2026-08-23T03:00:00Z');
    const times = ['12:00', '13:00', '14:00', '16:00', '17:00', '18:00', '20:00', '22:00'];
    const total = times.reduce(
      (n, t) =>
        n +
        timedSpawnsDue({ id: `s-${t}`, days_of_week: EVERY_DAY, start_times_utc: [t] }, now).length,
      0
    );
    expect(total).toBe(times.length);
  });

  it('still dedupes: the same instance keys identically from any clock', () => {
    const a = timedSpawnsDue(
      { id: 'sched', days_of_week: EVERY_DAY, start_times_utc: ['18:00'] },
      new Date('2026-08-22T20:00:00Z')
    );
    const b = timedSpawnsDue(
      { id: 'sched', days_of_week: EVERY_DAY, start_times_utc: ['18:00'] },
      new Date('2026-08-23T17:45:00Z')
    );
    expect(a[0].spawnKey).toBe('sched:2026-08-23:18:00');
    expect(b.map((d) => d.spawnKey)).toContain('sched:2026-08-23:18:00');
  });

  it('a weekly event appears a day out but not a week out', () => {
    const sunOnly = { id: 'sun', days_of_week: [0], start_times_utc: ['17:00'] };
    expect(timedSpawnsDue(sunOnly, new Date('2026-08-22T20:00:00Z'))).toHaveLength(1);
    expect(timedSpawnsDue(sunOnly, new Date('2026-08-19T20:00:00Z'))).toHaveLength(0);
  });

  it('a per-schedule override still wins, so the Major can open a week early', () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const due = timedSpawnsDue(
      { id: 'major', days_of_week: [0], start_times_utc: ['17:00'] },
      new Date('2026-08-19T20:00:00Z'),
      week
    );
    expect(due).toHaveLength(1);
  });
});

describe('horses do not occupy an event that has not started', () => {
  /**
   * Dan 2026-08-23 widened this from 15 minutes to an hour, to match the MTT
   * pre-start ramp: "HORSES NEED TO BE REGISTERING FOR MTT TOURNAMENTS UP TO
   * AN HOUR BEFORE THE TOURNAMENT STARTS."
   *
   * What this describe block is still protecting is unchanged and is the
   * reason the constant exists at all: a horse registered into TOMORROW's
   * event is a horse that cannot deal a cash table or fill a spin today, and
   * the pool is finite. An hour is a lobby-visibility window. A day is a
   * pool leak.
   */
  it('the seed window stays far shorter than the look-ahead', () => {
    expect(HORSE_SEED_WITHIN_MS).toBeLessThan(TIMED_WINDOW_AHEAD_MS);
    expect(HORSE_SEED_WITHIN_MS).toBe(60 * 60 * 1000);
  });

  it('matches the ramp window, so spawn-time seeding and the ramp agree', () => {
    expect(HORSE_SEED_WITHIN_MS).toBe(MTT_PRESTART_RAMP_MS);
  });

  it('an event published a day out is outside the seed window', () => {
    // The rule the spawner applies: startsWithinMs <= HORSE_SEED_WITHIN_MS.
    const tomorrow = 24 * 60 * 60 * 1000;
    expect(tomorrow <= HORSE_SEED_WITHIN_MS).toBe(false);
  });

  it('an event an hour or less away is inside it', () => {
    expect(5 * 60 * 1000 <= HORSE_SEED_WITHIN_MS).toBe(true);
    expect(59 * 60 * 1000 <= HORSE_SEED_WITHIN_MS).toBe(true);
    expect(61 * 60 * 1000 <= HORSE_SEED_WITHIN_MS).toBe(false);
  });
});
