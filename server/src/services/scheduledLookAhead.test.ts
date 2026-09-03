/**
 * The lobby-is-empty regression (Dan, 2026-08-23, reopened 2026-08-26).
 *
 * ROUND ONE. Thirty-eight schedules were live and firing exactly on time, yet
 * the board showed two joinable MTTs, because an event only existed for the 30
 * minutes before it started. The look-ahead became a day.
 *
 * ROUND TWO. A day was still not the board Dan wanted: "IT SHOULD BE
 * DISPLAYING ALL EVENTS THAT ARE SCHEDULED OVER THE NEXT 48 HOURS."
 *
 * ROUND THREE. "USE 72H/6 DAY FOR $200 BUY IN OR MORE." The look-ahead is now
 * 72 hours, and 6 days from a 200 buy-in UPWARD — inclusive, because the
 * Sunday Deep Stack is priced at exactly 200 and a strict `>` would have
 * excluded the one event the long window exists for. See spawnAheadMsFor. The client half of the same rule lives in
 * src/utils/tournamentScheduleWindow.ts and tests/unit/scheduleWindowParity
 * fails if the two drift.
 *
 * These pin that window, and the rule that horses do not occupy an event until
 * it is about to start.
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
  it('three full days of look-ahead, not one and not half an hour', () => {
    // 30 min -> 24h -> 48h -> 72h, each step because the board still looked
    // thinner than the schedule actually was. 72 is also what the tournament
    // lobby already used, so the two boards finally agree.
    expect(TIMED_WINDOW_AHEAD_MS).toBe(72 * 60 * 60 * 1000);
  });

  it('an 18:00 daily event is on the board the previous evening', () => {
    // 20:00 the night before: the old 30-minute window saw nothing at all.
    // At 72 hours a DAILY event is due three times, and the earliest of them
    // is still tomorrow evening's.
    const now = new Date('2026-08-22T20:00:00Z');
    const due = timedSpawnsDue(
      { id: 'sched-daily-big', days_of_week: EVERY_DAY, start_times_utc: ['18:00'] },
      now
    );
    expect(due).toHaveLength(3);
    expect(due[0].startTime.toISOString()).toBe('2026-08-23T18:00:00.000Z');
    expect(due[1].startTime.toISOString()).toBe('2026-08-24T18:00:00.000Z');
    expect(due[2].startTime.toISOString()).toBe('2026-08-25T18:00:00.000Z');
  });

  it('every daily schedule contributes an instance, so the board fills', () => {
    // Three editions each now, which is the whole point of the change: the
    // board carries the next three days rather than tomorrow alone.
    const now = new Date('2026-08-23T03:00:00Z');
    const times = ['12:00', '13:00', '14:00', '16:00', '17:00', '18:00', '20:00', '22:00'];
    const total = times.reduce(
      (n, t) =>
        n +
        timedSpawnsDue({ id: `s-${t}`, days_of_week: EVERY_DAY, start_times_utc: [t] }, now).length,
      0
    );
    expect(total).toBe(times.length * 3);
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

  it('a weekly event appears inside the window but not a week out', () => {
    // 2026-08-23 is a Sunday. From Saturday evening it is inside 72 hours;
    // from the Wednesday before (4 days) it is not.
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

  it('is DELIBERATELY shorter than the ramp window', () => {
    /* These were aligned on 2026-08-23, when both meant "about to start".
       They mean different things now. MTT_PRESTART_RAMP_MS is the whole field
       build and runs for the full 72-hour publish window, so the board is
       never a wall of empty games. This constant is the head start given at
       SPAWN, before the ramp has ticked once - and seeding three days early
       would put chips into a pool for an event that has only just appeared,
       for no gain, since the ramp reaches it within one tick anyway. */
    expect(HORSE_SEED_WITHIN_MS).toBeLessThan(MTT_PRESTART_RAMP_MS);
    expect(HORSE_SEED_WITHIN_MS).toBe(60 * 60 * 1000);
  });

  it('an event published a day out is outside the seed window', () => {
    // The rule the spawner applies: startsWithinMs <= HORSE_SEED_WITHIN_MS.
    // This matters MORE at a 48-hour look-ahead, not less: the further ahead
    // the board is published, the more horses a seed-at-spawn rule would lock
    // into games that have not started.
    const tomorrow = 24 * 60 * 60 * 1000;
    expect(tomorrow <= HORSE_SEED_WITHIN_MS).toBe(false);
    expect(2 * tomorrow <= HORSE_SEED_WITHIN_MS).toBe(false);
  });

  it('an event an hour or less away is inside it', () => {
    expect(5 * 60 * 1000 <= HORSE_SEED_WITHIN_MS).toBe(true);
    expect(59 * 60 * 1000 <= HORSE_SEED_WITHIN_MS).toBe(true);
    expect(61 * 60 * 1000 <= HORSE_SEED_WITHIN_MS).toBe(false);
  });
});
