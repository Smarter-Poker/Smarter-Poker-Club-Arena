/**
 * A SCHEDULE KEEPS ITS TIME ZONE (2026-09-24): the client's half.
 *
 * A recurring tournament schedule saves the creator's wall-clock weekday and
 * time together with their IANA zone (tournament_schedules.time_zone, migration
 * 20260924045822). The engine converts each occurrence for its own date, so a
 * "Repeats Weekly, 8:00 PM" event stays at 8:00 PM local across daylight
 * saving. A row with no zone is UTC, exactly as every row was before.
 */

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * The device's IANA time zone (e.g. 'America/Chicago'), or null when the
 * runtime cannot name one. Only an Area/Location name or UTC is returned: the
 * server refuses anything else (fn_schedule_time_zone_is_known), and a null
 * zone keeps the schedule on UTC rather than guessing.
 */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== 'string') return null;
    if (zone === 'UTC' || /^[A-Z][A-Za-z]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$/.test(zone)) {
      return zone;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * THE ENGINE MUST READ ZONES BEFORE A CLIENT WRITES THEM (2026-09-24).
 *
 * A zoned row stores the owner's wall clock ("Friday 20:00 America/Chicago").
 * An engine without scheduleWallClock reads every row's weekday and time as
 * UTC, so it would start that event at 20:00 UTC, hours early. The database
 * half is installed and the client half is merged, but the engine release
 * that reads zones (PR #5188) has not reached production: every engine
 * release since 2026-09-18 has been refused before cutover, and the running
 * engine is 8825af51. Until that release is verified live at
 * https://engine.smarter.poker/health, a schedule is written exactly as
 * before (UTC, no zone). Set this to true in the same change that records
 * the verified engine release.
 */
export const SCHEDULE_ZONES_REACH_THE_ENGINE = false;

/**
 * The zone a schedule write carries: the device's zone once the engine reads
 * zones, otherwise null (the UTC contract every engine understands).
 */
export function scheduleWriteTimeZone(
  engineReadsZones: boolean = SCHEDULE_ZONES_REACH_THE_ENGINE
): string | null {
  return engineReadsZones ? deviceTimeZone() : null;
}

/** The zone name shown beside a schedule's times; NULL means UTC. */
export function scheduleZoneLabel(timeZone: string | null | undefined): string {
  return timeZone || 'UTC';
}

/** 'HH:MM' (24h) of a Date on the device's own clock. */
export function localClockTime(at: Date): string {
  return at.toTimeString().slice(0, 5);
}
