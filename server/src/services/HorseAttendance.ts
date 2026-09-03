/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE ATTENDANCE — How many of a club's horses are playing, by time of day
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-03, binding:
 *
 *   "ALL CLUBS ARE RUNNING TOO MANY HORSES AT THE SAME TIME... PRIME TIME
 *    5PM-12AM HAS 45-60% OF THE MEMBERS IN THE CLUB PLAYING, MORNING FROM LIKE
 *    9AM-5PM SHOULD HAVE LIKE 20-25% AND LATE NIGHT, FROM 12AM-9AM SHOULD
 *    SLOWLY TRICKLE DOWN... NOT ALL AT ONCE, BUT LIKE HORSES START 'ORGANICALLY'
 *    QUITTING AND GOING TO SLEEP FOR THE NIGHT. WE SHOULDN'T HAVE MORE THAN 10%
 *    OF THE CLUB PLAYING BETWEEN 3AM-8AM. THEN THE NUMBERS SHOULD START PICKING
 *    BACK UP GRADUALLY."
 *
 * Measured the moment he said it (14:05 Chicago): 728 of 1,000 horses seated
 * platform-wide, 236 / 253 / 239 per club against rosters of 584 / 580 / 416 -
 * forty to fifty-seven percent of every club at two in the afternoon, and the
 * same at four in the morning, because nothing in the fleet knew what time it
 * was. The old daily "activity window" (HorseBehavior.isActiveNow) was a
 * hash-derived UTC window that kept ~55% of horses eligible at EVERY hour, and
 * the 2026-08-26 activity floor then pushed the count UP whenever it fell
 * under a third. Both are superseded by this file.
 *
 * Three ideas, all in this file, all pure so they can be unit-tested without
 * a database:
 *
 *  1. THE CURVE. `attendanceFraction(minuteOfDay)` is the share of a club's
 *     horse roster that should be seated at that Chicago minute. Piecewise
 *     linear through the anchors below, so it never steps - a lobby watched
 *     across a boundary sees a slope, not a cliff.
 *
 *  2. THE CHRONOTYPE. Every horse has a wake-up time and a bedtime, derived
 *     from its id hash, stable day to day. Most are day people; a few are
 *     night owls. `isAwake` says whether this horse would be playing at all
 *     right now, and `minutesPastBedtime` says how far past its bedtime it
 *     is, which is what makes departures ORGANIC: the early-to-bed horses
 *     drift off first, one at a time, and the owls are the ones still there
 *     at three. The curve is the club-level truth; the chronotype decides
 *     WHICH names make it up.
 *
 *  3. THE TRICKLE. Arrivals and departures are budgeted per cycle so the
 *     room fills and empties at a human pace even when the target moves a
 *     long way (a deploy, or 23:00 -> 03:00). The budgets are proportional to
 *     the gap, so the count approaches the target exponentially rather than
 *     snapping to it.
 *
 * The clock is America/Chicago (Dan: "WE ARE CHICAGO TIME HERE"), resolved
 * through Intl so daylight-saving is handled by the platform, not by us.
 *
 * NEVER refer to the horses as "bots" - they are HORSES only.
 */

import { horseHash, mix32 } from './HorseBehavior.js';

export const ATTENDANCE_TIME_ZONE = 'America/Chicago';

/**
 * Minute of the day (0..1439) in Chicago for a given instant. Uses Intl so
 * CST/CDT transitions are correct without a table of our own. Falls back to
 * UTC-5 if the runtime somehow lacks the zone (small ICU builds), which is
 * never worse than the UTC-hour hash it replaces.
 */
let cachedFormatter: Intl.DateTimeFormat | null | undefined;
export function chicagoMinuteOfDay(nowMs: number = Date.now()): number {
  if (cachedFormatter === undefined) {
    try {
      cachedFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: ATTENDANCE_TIME_ZONE,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      cachedFormatter = null;
    }
  }
  if (cachedFormatter) {
    const parts = cachedFormatter.formatToParts(new Date(nowMs));
    let h = 0;
    let m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = Number(p.value) % 24;
      else if (p.type === 'minute') m = Number(p.value);
    }
    return h * 60 + m;
  }
  const d = new Date(nowMs - 5 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Chicago day-of-week (0 = Sunday) for the weekend lift. */
export function chicagoDayOfWeek(nowMs: number = Date.now()): number {
  try {
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: ATTENDANCE_TIME_ZONE,
      weekday: 'short',
    }).format(new Date(nowMs));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  } catch {
    return new Date(nowMs - 5 * 3_600_000).getUTCDay();
  }
}

/**
 * THE CURVE. [minuteOfDay, fraction of roster seated]. Linear between anchors,
 * wrapping at midnight. Dan gave the bands and said "feel free to adjust";
 * these sit inside every band he named:
 *
 *   03:00-08:00  dead zone, under 10%          (he said: never more than 10%)
 *   08:00-09:00  the first players come back    (gradual)
 *   09:00-17:00  daytime, 20-25%                (he said: 20-25%)
 *   16:00-17:00  ramp into the evening
 *   17:00-00:00  prime time, 45-60%             (he said: 45-60%)
 *   00:00-03:00  the wind-down: people quit and go to sleep, one at a time
 */
export const ATTENDANCE_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0 * 60, 0.45], // midnight: prime is ending
  [1 * 60, 0.3],
  [2 * 60, 0.17],
  [3 * 60, 0.09], // dead zone begins - under 10% from here to 08:00
  [5 * 60, 0.05],
  [7 * 60, 0.05],
  [8 * 60, 0.09],
  [9 * 60, 0.15],
  [10 * 60, 0.2],
  [12 * 60, 0.22],
  [14 * 60, 0.22],
  [15 * 60, 0.24],
  [16 * 60, 0.3],
  [17 * 60, 0.45],
  [19 * 60, 0.52],
  [21 * 60, 0.57],
  [22 * 60, 0.56],
  [23 * 60, 0.52],
  [24 * 60, 0.45], // = midnight, closes the loop
];

/** Friday and Saturday evenings run a little hotter. Never leaves Dan's band. */
const WEEKEND_PRIME_LIFT = 0.03;

/**
 * Share of a club's horse roster that should be seated at this Chicago minute.
 * Pure in (minuteOfDay, dayOfWeek). Clamped to [0, 1].
 */
export function attendanceFraction(minuteOfDay: number, dayOfWeek: number = 1): number {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  let f = ATTENDANCE_CURVE[0][1];
  for (let i = 1; i < ATTENDANCE_CURVE.length; i++) {
    const [m0, f0] = ATTENDANCE_CURVE[i - 1];
    const [m1, f1] = ATTENDANCE_CURVE[i];
    if (m >= m0 && m <= m1) {
      f = m1 === m0 ? f1 : f0 + ((f1 - f0) * (m - m0)) / (m1 - m0);
      break;
    }
  }
  const weekend = dayOfWeek === 5 || dayOfWeek === 6;
  if (weekend && m >= 17 * 60) f += WEEKEND_PRIME_LIFT;
  return Math.max(0, Math.min(1, f));
}

/**
 * How many of `rosterSize` horses this club wants seated right now.
 *
 * A small deterministic wobble (up to +/-4% of the target, re-rolled every 20
 * minutes per club) keeps three clubs from tracking the curve in lockstep,
 * which is the kind of uniformity a watching player notices. It cannot push
 * the dead-zone target past 10% because the wobble is proportional.
 */
export function attendanceTarget(
  clubId: string,
  rosterSize: number,
  nowMs: number = Date.now()
): number {
  if (!Number.isFinite(rosterSize) || rosterSize <= 0) return 0;
  const f = attendanceFraction(chicagoMinuteOfDay(nowMs), chicagoDayOfWeek(nowMs));
  const bucket = Math.floor(nowMs / (20 * 60_000));
  const seed = mix32((horseHash(`${clubId}:attendance`) ^ Math.imul(bucket, 0x9e3779b1)) >>> 0);
  const wobble = 1 + (((seed % 2001) - 1000) / 1000) * 0.04;
  return Math.max(0, Math.round(rosterSize * f * wobble));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHRONOTYPE
// ═══════════════════════════════════════════════════════════════════════════════

export interface Chronotype {
  /** Chicago minute the horse is willing to sit down from. */
  wakeMinute: number;
  /** Chicago minute after which the horse wants to go home. Exceeds 1440 past midnight. */
  bedMinute: number;
  owl: boolean;
}

/** Share of the stable that are night owls - the ones still there at 03:00. */
export const OWL_FRACTION = 0.15;

/**
 * Stable per-horse sleep schedule from the id hash. Day people wake between
 * 06:30 and 16:00 and go to bed between 22:30 and 03:30; owls wake between
 * 14:00 and 19:00 and go to bed between 04:30 and 08:30. Spread evenly over
 * those windows so that the eligible pool is always wider than the curve
 * wants - the curve, not the chronotype, decides the count.
 */
export function chronotypeFor(horseId: string): Chronotype {
  const a = mix32(horseHash(`${horseId}:wake`));
  const b = mix32(horseHash(`${horseId}:bed`));
  const c = mix32(horseHash(`${horseId}:owl`));
  const owl = c % 1000 < OWL_FRACTION * 1000;
  if (owl) {
    const wakeMinute = 14 * 60 + (a % (5 * 60)); // 14:00-19:00
    const bedMinute = 28 * 60 + 30 + (b % (4 * 60)); // 04:30-08:30 next day
    return { wakeMinute, bedMinute, owl };
  }
  const wakeMinute = 6 * 60 + 30 + (a % (9 * 60 + 30)); // 06:30-16:00
  const bedMinute = 22 * 60 + 30 + (b % (5 * 60)); // 22:30-03:30
  return { wakeMinute, bedMinute, owl };
}

/** A Chicago minute placed on the horse's own unwrapped clock (wake .. wake+1440). */
function unwrapForHorse(minuteOfDay: number, wakeMinute: number): number {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return m < wakeMinute ? m + 1440 : m;
}

/**
 * Is this horse inside its waking window at this Chicago minute? The window
 * always crosses midnight on the bed side, so the test is on an unwrapped
 * clock: a minute before the wake-up time belongs to the previous day.
 */
export function isAwake(horseId: string, minuteOfDay: number): boolean {
  const { wakeMinute, bedMinute } = chronotypeFor(horseId);
  const u = unwrapForHorse(minuteOfDay, wakeMinute);
  return u >= wakeMinute && u < bedMinute;
}

/**
 * Minutes past bedtime, or 0 while still awake. Drives the organic quit: the
 * further past bedtime, the surer the departure, so the early sleepers leave
 * first and nobody leaves in a block.
 */
export function minutesPastBedtime(horseId: string, minuteOfDay: number): number {
  const { wakeMinute, bedMinute } = chronotypeFor(horseId);
  const u = unwrapForHorse(minuteOfDay, wakeMinute);
  return u < bedMinute ? 0 : u - bedMinute;
}

/**
 * Per-cycle probability that a horse past its bedtime racks up. ~10% per
 * 90-second cycle at bedtime, ~50% an hour past, certain two hours past.
 * Scaled to the caller's cycle length.
 */
export function bedtimeLeaveProbability(pastMinutes: number, cycleMinutes: number): number {
  if (pastMinutes <= 0) return 0;
  const perCycle = 0.1 + Math.min(1, pastMinutes / 120) * 0.9;
  return Math.min(1, perCycle * (cycleMinutes / 1.5));
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE TRICKLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How many NEW horses (not already seated somewhere in this club) the fleet
 * may wake this cycle. Proportional to the shortfall so a cold floor fills
 * over ten to fifteen minutes rather than one pass, and a steady floor
 * replaces its leavers one or two at a time.
 */
export function arrivalsBudget(seated: number, target: number, rosterSize: number): number {
  const gap = target - seated;
  if (gap <= 0) return 0;
  const floor = Math.max(1, Math.ceil(rosterSize * 0.004)); // 584 -> 3 per cycle at steady state
  return Math.min(gap, Math.max(floor, Math.ceil(gap * 0.08)));
}

/**
 * How many horses over the club's target go home this cycle. Proportional
 * to the excess (15%, one to eight): 250 over target after a deploy takes
 * about forty 90-second cycles to walk down, and the ordinary
 * evening wind-down from 57% to 9% between 21:00 and 03:00 - some 275
 * horses in a 584 club - keeps pace at one or two a cycle.
 */
export function departuresBudget(seated: number, target: number): number {
  const over = seated - target;
  if (over <= 0) return 0;
  return Math.max(1, Math.min(8, Math.ceil(over * 0.15)));
}

/**
 * Order seated horses by who should go home FIRST: furthest past bedtime,
 * then (among the still-awake) whoever's bedtime is soonest. Deterministic,
 * so two consecutive cycles pick the same next sleeper rather than a fresh
 * random one - which is what makes the wind-down look like people leaving
 * rather than a room being thinned.
 */
export function sleepPriority(horseId: string, minuteOfDay: number): number {
  const { wakeMinute, bedMinute } = chronotypeFor(horseId);
  const u = unwrapForHorse(minuteOfDay, wakeMinute);
  if (u >= bedMinute) return 10_000 + (u - bedMinute);
  return Math.max(0, 1440 - (bedMinute - u));
}

// ═══════════════════════════════════════════════════════════════════════════════
// YIELDING A SEAT TO A PERSON (Dan 2026-09-03)
// ═══════════════════════════════════════════════════════════════════════════════
//
//   "IF A GAME IS FULL, AND A HORSE IS IN THE GAME, WHILE A HUMAN IS WAITING,
//    A HORSE SHOULD CASH OUT, TO MAKE A SEAT FOR THE HUMAN (BUT NOT RIGHT AWAY,
//    AFTER A COUPLE HANDS) AND IF THE HUMAN IS 'A COUPLE PLAYERS BACK' THEN A
//    COUPLE HORSES SHOULD BE LEAVING THE TABLE (SLOWLY, WITHIN A COUPLE MINUTES
//    OF EACH OTHER, TO MAKE A SEAT AVAILABLE FOR THE HUMAN, IT CAN'T BE
//    OBVIOUS..."
//
// The rotator already stands up exactly as many horses as there are humans in
// the queue (2026-09-02). What it did not have was TIMING: the first horse
// left on the very next cycle, and the next on the cycle after. These helpers
// put the pause in. A hand at these tables runs roughly a minute, so "a couple
// hands" is two to four minutes; the gap between successive yields is a little
// shorter and never identical twice.

/** Delay from a human joining the queue to the first horse standing up. */
export function firstYieldDelayMs(tableId: string, sinceMs: number): number {
  const r = mix32(horseHash(`${tableId}:${sinceMs}:first`)) % 1000;
  return 120_000 + Math.floor((r / 1000) * 120_000); // 2-4 minutes
}

/** Gap between one yielded seat and the next at the same table. */
export function nextYieldGapMs(tableId: string, lastMs: number): number {
  const r = mix32(horseHash(`${tableId}:${lastMs}:next`)) % 1000;
  return 90_000 + Math.floor((r / 1000) * 90_000); // 1.5-3 minutes
}

/**
 * The per-table yield clock. `since` is when a human was first seen waiting,
 * `lastYieldAt` when a horse last stood up for the queue. Returns whether a
 * horse may stand up NOW. Pure, so the rotator's state stays a plain map.
 */
export function mayYieldNow(
  tableId: string,
  state: { since: number; lastYieldAt: number | null },
  nowMs: number
): boolean {
  if (state.lastYieldAt === null) {
    return nowMs - state.since >= firstYieldDelayMs(tableId, state.since);
  }
  return nowMs - state.lastYieldAt >= nextYieldGapMs(tableId, state.lastYieldAt);
}
