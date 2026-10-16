/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FIXED BOARD IS HARD CODED HERE (Dan 2026-10-15 and 2026-10-16, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "TOURNAMENTS CAN NEVER FAIL, AND MUST ALWAYS RUN AND SPAWN,
 * INSTEAD OF RANDOMLY SPAWNING THEM, PUT THEM ON A HARD CODED SCHEDULE", "THESE
 * SAME CORRECTIONS NEED TO BE MADE INSIDE OF THE DIAMOND ARENA AS WELL", and
 * "I WANT ALL HARD CODED SCHEDULED EVENTS ONLY".
 *
 * The daily board of the Midway Union and the Diamond Arena: five Free Buys,
 * fifteen lobby MTTs and five union MTTs, at fixed America/Chicago times every
 * day, 53 starts a day per club. This file IS the schedule. The engine writes
 * it into tournament_schedules itself (ScheduledTournamentService
 * syncFixedBoard), so the rows a scheduler reads are always the rows the
 * running binary knows how to build: a schedule can no longer exist ahead of
 * the code that runs it.
 *
 * WHY THAT MATTERS (the root cause of 2026-10-16 00:10-01:03 Chicago). The
 * first version of this board was a database migration. It went live an hour
 * before the engine that could build it, so the engine then serving refused
 * every occurrence it read and paged "could not be created" eight times until
 * the release landed. Data was deployed ahead of its code. Owning the board
 * in code makes that ordering impossible: the same release carries both.
 *
 * Every name is a template the engine builds with the timer's own builders
 * (fixedBoardRow). theBoardIsAFixedSchedule.law.test.ts proves every entry
 * resolves, for both clubs, so an unknown template cannot ship.
 */

export const FIXED_BOARD_TIME_ZONE = 'America/Chicago';

/**
 * How often a running engine writes the board again (2026-10-16 audit). The
 * first version wrote it once per process, so a board row that was switched
 * off or edited after boot stayed wrong until the next release, possibly for
 * days. Re-asserting it every ten minutes costs one indexed read when nothing
 * changed, and a drifted row is back on the code within one interval.
 */
export const FIXED_BOARD_RESYNC_MS = 10 * 60_000;

/** True for a tournament_schedules config the engine owns (the hard-coded board). */
export function isFixedBoardConfig(config: unknown): boolean {
  return (
    !!config &&
    typeof config === 'object' &&
    !Array.isArray(config) &&
    ((config as Record<string, unknown>).type === 'fixed_board' ||
      typeof (config as Record<string, unknown>).fixedBoard === 'string')
  );
}

export interface FixedBoardClub {
  clubId: string;
  /** tournaments.union_id: the union id for the Midway Union, null for the arena. */
  unionId: string | null;
  label: string;
}

export const FIXED_BOARD_CLUBS: readonly FixedBoardClub[] = [
  {
    clubId: 'fade0000-0000-0000-0000-000000000001',
    unionId: 'fade0000-0000-0000-0000-000000000001',
    label: 'Midway Union',
  },
  {
    clubId: '002c2d27-9584-4e52-835a-bb2be148fc81',
    unionId: null,
    label: 'Diamond Arena',
  },
];

export interface FixedBoardEvent {
  /** The published name, and the template the engine builds it from. */
  name: string;
  /** Chicago wall-clock start times, HH:MM, every day. */
  times: readonly string[];
  /**
   * The times this event ran at before the 2026-10-16 respacing. Dates that
   * already have an occurrence at one of them keep them; every later date
   * takes `times` (ScheduledTournamentService resolveTimeChange). Absent for
   * an event whose times did not move.
   */
  previousTimes?: readonly string[];
  /** Field head start the scheduler gives an event inside its last hour. */
  horses: number;
}

/**
 * THE BOARD IS SPREAD OUT (Dan 2026-10-16): "REDO THEM SO TOURNAMENT DO NOT
 * START AT THE SAME TIME, THAT THEY ARE SPREAD OUT ACCORDINGLY THROUGHOUT THE
 * DAY."
 *
 * The first board started two events at the same minute 19 times a day, and
 * named events for a time of day they did not run at (the Early Bird Freeroll
 * at 10:30 PM, Lunch Rush at 7:30 AM, the Prime Time Main Event at 1:30 PM).
 *
 * Every start is now on a 20-minute grid (:00, :20, :40), one event per grid
 * slot, across the WHOLE day in each club: these 53 board starts plus the
 * club's own scheduled events, whose slots are reserved in WEEKLY_EVENT_SLOTS
 * below. The five Free Buys keep their five hours. Each event runs in the part
 * of the day its name says, its repeats at least an hour apart.
 */
export const FIXED_BOARD_TIMES_EFFECTIVE_FROM = '2026-10-17';

export const FIXED_BOARD: readonly FixedBoardEvent[] = [
  { name: 'Midnight Free Buy (NLH)', times: ['00:00'], horses: 0 },
  { name: 'Morning Free Buy (NLH)', times: ['08:00'], horses: 0 },
  { name: 'Midday Free Buy (NLH)', times: ['12:00'], horses: 0 },
  { name: 'Afternoon Free Buy (NLH)', times: ['16:00'], horses: 0 },
  { name: 'Prime Time Free Buy (NLH)', times: ['20:00'], horses: 0 },
  // Overnight, 12:40 AM - 4:40 AM.
  {
    name: 'Midnight Bounty (NLH)',
    times: ['00:40', '02:20', '23:40'],
    previousTimes: ['19:30', '20:45', '22:00'],
    horses: 12,
  },
  {
    name: 'Late Night Grind (PLO4)',
    times: ['01:00', '03:00', '23:20'],
    previousTimes: ['19:30', '20:40', '21:50'],
    horses: 10,
  },
  {
    name: 'Pre-Dawn Mystery Bounty (PLO5)',
    times: ['01:20', '03:20', '04:40'],
    previousTimes: ['22:30', '23:45', '01:00'],
    horses: 15,
  },
  {
    name: 'Night Owl Special (NLH)',
    times: ['01:40', '03:40', '22:20'],
    previousTimes: ['16:30', '17:50', '19:10'],
    horses: 25,
  },
  {
    name: 'Late Night PKO (PLO4)',
    times: ['02:00', '04:20', '21:40'],
    previousTimes: ['16:30', '17:50', '19:10'],
    horses: 20,
  },
  // Morning, 4:00 AM - 10:40 AM.
  {
    name: 'Early Bird Freeroll (NLH)',
    times: ['04:00', '05:20', '07:00'],
    previousTimes: ['22:30', '23:45', '01:00'],
    horses: 20,
  },
  {
    name: 'Sunrise Bounty (NLH)',
    times: ['05:00', '06:40', '07:40'],
    previousTimes: ['01:30', '02:50', '04:10'],
    horses: 16,
  },
  { name: 'Union Morning Classic (NLH)', times: ['05:40'], previousTimes: ['05:30'], horses: 20 },
  {
    name: 'Morning Grinder (PLO)',
    times: ['06:00', '07:20', '08:40'],
    previousTimes: ['01:30', '02:50', '04:10'],
    horses: 14,
  },
  {
    name: 'Mid-Morning Turbo (6-Max NLH)',
    times: ['08:20', '09:40', '10:40'],
    previousTimes: ['04:30', '05:50', '07:10'],
    horses: 12,
  },
  {
    name: 'Coffee Break Freeroll (PLO4)',
    times: ['09:20', '11:00', '13:20'],
    previousTimes: ['10:30', '11:45', '13:00'],
    horses: 14,
  },
  // Midday, 10:20 AM - 3:40 PM.
  {
    name: 'Brunch Special PKO (PLO8)',
    times: ['10:20', '11:20', '12:40'],
    previousTimes: ['04:30', '05:50', '07:10'],
    horses: 15,
  },
  { name: 'Lunch Rush (NLH Deep)', times: ['11:40'], previousTimes: ['07:30'], horses: 20 },
  {
    name: 'Afternoon Bounty (NLH)',
    times: ['13:40', '14:40', '15:40'],
    previousTimes: ['10:30', '11:50', '13:10'],
    horses: 18,
  },
  { name: 'Union PKO Afternoon (PLO4)', times: ['14:20'], previousTimes: ['09:30'], horses: 18 },
  {
    name: 'Union Mystery Bounty (PLO5)',
    times: ['15:20', '16:20'],
    previousTimes: ['14:30', '15:50'],
    horses: 22,
  },
  // Evening, 4:40 PM - 7:40 PM.
  {
    name: 'Evening Mystery Bounty (PLO5)',
    times: ['16:40', '17:40', '19:40'],
    previousTimes: ['13:30', '14:50', '16:10'],
    horses: 18,
  },
  {
    name: 'Union Grand Championship (NLH)',
    times: ['17:00'],
    previousTimes: ['14:30'],
    horses: 30,
  },
  { name: 'Prime Time Main Event (NLH)', times: ['18:40'], previousTimes: ['13:30'], horses: 30 },
  // Late night, 9:20 PM - 10:40 PM (the rest of the night is above).
  {
    name: 'Union Late Night Turbo (NLH)',
    times: ['21:20', '22:40'],
    previousTimes: ['17:30', '18:50'],
    horses: 16,
  },
];

/**
 * The Chicago start slots each club's OWN scheduled events hold every day
 * (tournament_schedules rows that are not the board, pinned to Chicago time by
 * migration 20261016170754), so the board can never be laid on top of them:
 * the four 100 Guarantee Freerolls, the Sunday Deep Stack satellites, the
 * Sunday 200 Deep Stack (Sundays), and the one weekly event each night at
 * 2:40 AM, 9 AM, 3 PM, 7 PM, 8:20 PM, 9 PM, 10 PM and 11 PM.
 */
export const WEEKLY_EVENT_SLOTS: readonly string[] = [
  '00:20',
  '02:40',
  '06:20',
  '09:00',
  '10:00',
  '12:20',
  '13:00',
  '14:00',
  '15:00',
  '18:00',
  '18:20',
  '19:00',
  '20:20',
  '20:40',
  '21:00',
  '22:00',
  '23:00',
];

/** Minutes between two board-or-weekly starts in one club, at least. */
export const BOARD_START_SPACING_MINUTES = 20;

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** The tournament_schedules row a fixed-board event is held in. */
export interface FixedBoardRow {
  club_id: string;
  union_id: string | null;
  name: string;
  description: string;
  active: true;
  days_of_week: number[];
  start_times_utc: string[];
  interval_minutes: null;
  time_zone: string;
  config: {
    type: 'fixed_board';
    fixedBoard: string;
    horsesToRegister: number;
    previousStartTimes?: string[];
    startTimesEffectiveFrom?: string;
  };
}

export function fixedBoardRowFor(club: FixedBoardClub, event: FixedBoardEvent): FixedBoardRow {
  return {
    club_id: club.clubId,
    union_id: club.unionId,
    name: event.name,
    description: 'Fixed Daily Board',
    active: true,
    days_of_week: [...EVERY_DAY],
    start_times_utc: [...event.times],
    interval_minutes: null,
    time_zone: FIXED_BOARD_TIME_ZONE,
    config: {
      type: 'fixed_board',
      fixedBoard: event.name,
      horsesToRegister: event.horses,
      ...(event.previousTimes
        ? {
            previousStartTimes: [...event.previousTimes],
            startTimesEffectiveFrom: FIXED_BOARD_TIMES_EFFECTIVE_FROM,
          }
        : {}),
    },
  };
}

/** A tournament_schedules row that carries a fixed-board config, as read. */
export interface ExistingFixedBoardRow {
  id: string;
  club_id: string;
  active: boolean;
  days_of_week: number[] | null;
  start_times_utc: string[] | null;
  time_zone: string | null;
  config: Record<string, unknown> | null;
}

export interface FixedBoardSyncPlan {
  inserts: FixedBoardRow[];
  updates: { id: string; row: FixedBoardRow }[];
  deactivate: string[];
}

const sameList = (a: readonly unknown[] | null, b: readonly unknown[]) =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

const sameOptionalList = (a: unknown, b: readonly unknown[] | undefined) =>
  b === undefined ? a === undefined : Array.isArray(a) && sameList(a, b);

/**
 * PURE. What has to change in tournament_schedules so it holds exactly the
 * hard-coded board: one active row per (club, event) carrying this file's
 * times, a new row for an event the table lacks, and every other fixed-board
 * row inactive. An empty plan is the steady state.
 */
export function planFixedBoardSync(
  existing: readonly ExistingFixedBoardRow[],
  clubs: readonly FixedBoardClub[] = FIXED_BOARD_CLUBS,
  board: readonly FixedBoardEvent[] = FIXED_BOARD
): FixedBoardSyncPlan {
  const plan: FixedBoardSyncPlan = { inserts: [], updates: [], deactivate: [] };
  const kept = new Set<string>();
  for (const club of clubs) {
    for (const event of board) {
      const want = fixedBoardRowFor(club, event);
      const mine = existing.filter(
        (r) => r.club_id === club.clubId && r.config?.fixedBoard === event.name
      );
      const anchor = mine.find((r) => r.active) ?? mine[0];
      if (!anchor) {
        plan.inserts.push(want);
        continue;
      }
      kept.add(anchor.id);
      const current =
        anchor.active &&
        anchor.time_zone === want.time_zone &&
        sameList(anchor.days_of_week, want.days_of_week) &&
        sameList(anchor.start_times_utc, want.start_times_utc) &&
        anchor.config?.type === want.config.type &&
        anchor.config?.horsesToRegister === want.config.horsesToRegister &&
        sameOptionalList(anchor.config?.previousStartTimes, want.config.previousStartTimes) &&
        anchor.config?.startTimesEffectiveFrom === want.config.startTimesEffectiveFrom;
      if (!current) plan.updates.push({ id: anchor.id, row: want });
    }
  }
  for (const r of existing) {
    if (r.active && !kept.has(r.id)) plan.deactivate.push(r.id);
  }
  return plan;
}
