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
 * sixteen lobby MTTs and five union MTTs, each once a day at a fixed
 * America/Chicago time (26 starts Monday to Saturday, 11 on Sunday, when the
 * clubs' Sunday Funday series holds 11 AM to 11 PM). This file IS the schedule. The engine writes
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

/** True for a club whose tournaments are this file's board (Midway Union, Diamond Arena). */
export function isFixedBoardClub(clubId: string | null | undefined): boolean {
  return !!clubId && FIXED_BOARD_CLUBS.some((c) => c.clubId === clubId);
}

export interface FixedBoardEvent {
  /** The published name, and the template the engine builds it from. */
  name: string;
  /** Chicago wall-clock start times, HH:MM. */
  times: readonly string[];
  /** Days of the week it runs (0 = Sunday). Absent = every day. */
  days?: readonly number[];
  /**
   * The times this event ran at before the current timetable. Dates that
   * already have an occurrence at one of them keep them; every later date
   * takes `times` (ScheduledTournamentService resolveTimeChange). Absent for
   * an event whose times did not move.
   */
  previousTimes?: readonly string[];
  /**
   * The times of the timetable before `previousTimes`. A date that already
   * ran on one of them was planned under that older timetable and takes
   * nothing more, so a second change in two days can never add a third set of
   * starts to a date that is half over.
   */
  retiredTimes?: readonly string[];
  /**
   * First Chicago date a NEW event runs. Dates before it were already planned
   * under the previous timetable, so the event joins the board on the first
   * date the new timetable owns.
   */
  startsFrom?: string;
  /** Field head start the scheduler gives an event inside its last hour. */
  horses: number;
}

/**
 * A REAL ROOM'S DAY (Dan 2026-10-16, BINDING).
 *
 * Dan, verbatim: "WHY THE FUCK DO WE HAVE A TOURNAMENT EVERY 20 MINUTES IN THE
 * MIDDLE OF THE NIGHT, LOOK AT REAL ONLINE POKER SCHEDULES FROM THE TOP SITES",
 * then "SATELLITES ARE NEVER 'PRIME TOURNAMENTS'. YOU SHOULD ALWAYS HAVE A REAL
 * TOURNAMENT RUNNING IN THOSE SPOTS, ALL SATELLITES SHOULD START AT THE :15 OR
 * :45", and "DOUBLE ALL THE OTHER CURRENT GUARANTEES, THEN ROUND THEM ALL UP TO
 * THE NEAREST 1000 OR 500".
 *
 * Then: "TOURNAMENTS FROM 6PM -10PM SHOULD BE LARGER BUY IN, AND SUNDAY SHOULD
 * BE JAM PACKED FROM 11AM TO 11PM WITH TOURNAMENTS, BIGGER BUY IN'S BIGGER
 * GUARANTEES. AND MAKE SURE THE FREE BUY TOURNAMENTS ARE STILL RUNNING AT THE
 * SAME TIMES EVERY DAY. AT 8:30AM, 12:30PM 4:30PM 8:30PM AND 12:30AM EVERY DAY."
 *
 * The US-facing rooms (PokerStars NJ, ACR, BetMGM) start their tournaments
 * between early afternoon and midnight Eastern, their flagship daily at 7 PM
 * Eastern, and nothing overnight. So the day here is:
 *   - one real tournament on every :00 and :30 from 8 AM to 1 AM Chicago,
 *     board events and the clubs' own weekly events together (WEEKLY_EVENT_SLOTS);
 *   - satellites only on the :15 and :45 (SATELLITE_SLOTS), never on a slot a
 *     real tournament should hold;
 *   - nothing at all between 1:30 AM and 8 AM;
 *   - each board event once a day.
 * theBoardIsAFixedSchedule.law.test.ts pins every one of those.
 */
export const FIXED_BOARD_TIMES_EFFECTIVE_FROM = '2026-10-17';

/**
 * The first date the 2026-10-16 timetable owns outright: every date before it
 * was already spawned (three days ahead) under the old one when it shipped.
 */
export const NEW_BOARD_EVENTS_START = '2026-10-20';

const MON_TO_SAT = [1, 2, 3, 4, 5, 6] as const;

export const FIXED_BOARD: readonly FixedBoardEvent[] = [
  // Morning, 8:00 AM - 10:30 AM, every day.
  {
    name: 'Sunrise Bounty (NLH)',
    times: ['08:00'],
    previousTimes: ['05:00', '06:40', '07:40'],
    retiredTimes: ['01:30', '02:50', '04:10'],
    horses: 16,
  },
  { name: 'Morning Free Buy (NLH)', times: ['08:30'], previousTimes: ['08:00'], horses: 0 },
  {
    name: 'Morning Grinder (PLO)',
    times: ['09:30'],
    previousTimes: ['06:00', '07:20', '08:40'],
    retiredTimes: ['01:30', '02:50', '04:10'],
    horses: 14,
  },
  {
    name: 'Mid-Morning Turbo (6-Max NLH)',
    times: ['10:00'],
    previousTimes: ['08:20', '09:40', '10:40'],
    retiredTimes: ['04:30', '05:50', '07:10'],
    horses: 12,
  },
  {
    name: 'Brunch Special PKO (PLO8)',
    times: ['10:30'],
    previousTimes: ['10:20', '11:20', '12:40'],
    retiredTimes: ['04:30', '05:50', '07:10'],
    horses: 15,
  },
  // 11:00 AM - 11:00 PM, Monday to Saturday. On Sunday these half hours belong
  // to the Sunday Funday series (the clubs' own weekly events).
  {
    name: 'Coffee Break Freeroll (PLO4)',
    times: ['11:00'],
    days: MON_TO_SAT,
    previousTimes: ['09:20', '11:00', '13:20'],
    retiredTimes: ['10:30', '11:45', '13:00'],
    horses: 14,
  },
  {
    name: 'Union Morning Classic (NLH)',
    times: ['11:30'],
    days: MON_TO_SAT,
    previousTimes: ['05:40'],
    retiredTimes: ['05:30'],
    horses: 20,
  },
  {
    name: 'Lunch Rush (NLH Deep)',
    times: ['12:00'],
    days: MON_TO_SAT,
    previousTimes: ['11:40'],
    retiredTimes: ['07:30'],
    horses: 20,
  },
  { name: 'Midday Free Buy (NLH)', times: ['12:30'], previousTimes: ['12:00'], horses: 0 },
  {
    name: 'Midday Turbo (NLH)',
    times: ['13:00'],
    days: MON_TO_SAT,
    startsFrom: NEW_BOARD_EVENTS_START,
    horses: 16,
  },
  {
    name: 'Afternoon Bounty (NLH)',
    times: ['13:30'],
    days: MON_TO_SAT,
    previousTimes: ['13:40', '14:40', '15:40'],
    retiredTimes: ['10:30', '11:50', '13:10'],
    horses: 18,
  },
  {
    name: 'Union PKO Afternoon (PLO4)',
    times: ['14:00'],
    days: MON_TO_SAT,
    previousTimes: ['14:20'],
    retiredTimes: ['09:30'],
    horses: 18,
  },
  {
    name: 'Afternoon Deep Stack (NLH)',
    times: ['14:30'],
    days: MON_TO_SAT,
    startsFrom: NEW_BOARD_EVENTS_START,
    horses: 20,
  },
  {
    name: 'Union Mystery Bounty (PLO5)',
    times: ['15:30'],
    days: MON_TO_SAT,
    previousTimes: ['15:20', '16:20'],
    retiredTimes: ['14:30', '15:50'],
    horses: 22,
  },
  {
    name: 'Evening Mystery Bounty (PLO5)',
    times: ['16:00'],
    days: MON_TO_SAT,
    previousTimes: ['16:40', '17:40', '19:40'],
    retiredTimes: ['13:30', '14:50', '16:10'],
    horses: 18,
  },
  { name: 'Afternoon Free Buy (NLH)', times: ['16:30'], previousTimes: ['16:00'], horses: 0 },
  // Prime time, 5:00 PM - 10:30 PM: the dearest events of the day. The 6 PM
  // Main Event is 7 PM Eastern.
  {
    name: 'Union Grand Championship (NLH)',
    times: ['17:00'],
    days: MON_TO_SAT,
    horses: 30,
  },
  {
    name: 'Happy Hour Bounty (NLH)',
    times: ['17:30'],
    days: MON_TO_SAT,
    startsFrom: NEW_BOARD_EVENTS_START,
    horses: 20,
  },
  {
    name: 'Prime Time Main Event (NLH)',
    times: ['18:00'],
    days: MON_TO_SAT,
    previousTimes: ['18:40'],
    retiredTimes: ['13:30'],
    horses: 30,
  },
  {
    name: 'Dinner Break PLO (PLO4)',
    times: ['18:30'],
    days: MON_TO_SAT,
    startsFrom: NEW_BOARD_EVENTS_START,
    horses: 20,
  },
  { name: 'Prime Time Free Buy (NLH)', times: ['20:30'], previousTimes: ['20:00'], horses: 0 },
  {
    name: 'Late Night PKO (PLO4)',
    times: ['21:30'],
    days: MON_TO_SAT,
    previousTimes: ['02:00', '04:20', '21:40'],
    retiredTimes: ['16:30', '17:50', '19:10'],
    horses: 20,
  },
  {
    name: 'Night Owl Special (NLH)',
    times: ['22:30'],
    days: MON_TO_SAT,
    previousTimes: ['01:40', '03:40', '22:20'],
    retiredTimes: ['16:30', '17:50', '19:10'],
    horses: 25,
  },
  // Late night, 11:30 PM - 12:30 AM, every day. Nothing after 1 AM.
  {
    name: 'Union Late Night Turbo (NLH)',
    times: ['23:30'],
    previousTimes: ['21:20', '22:40'],
    retiredTimes: ['17:30', '18:50'],
    horses: 16,
  },
  {
    name: 'Midnight Bounty (NLH)',
    times: ['00:00'],
    previousTimes: ['00:40', '02:20', '23:40'],
    retiredTimes: ['19:30', '20:45', '22:00'],
    horses: 12,
  },
  { name: 'Midnight Free Buy (NLH)', times: ['00:30'], previousTimes: ['00:00'], horses: 0 },
];

/**
 * The half hours the clubs' OWN weekly events hold, and on which days
 * (tournament_schedules rows that are not the board, set by migration
 * *_a_real_rooms_day): the graveyard at 1 AM, a morning event at 9 AM, an
 * afternoon event at 3 PM, the Nightly 10K at 7 PM Monday to Saturday (the
 * Sunday Funday Warm-Up on Sunday), the openers at 7:30, and the evening
 * events at 8, 9, 10 and 11 PM every day; and on Sunday, every half hour from
 * 11 AM to 11 PM that the board leaves to the Sunday Funday series.
 */
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6] as const;
const SUNDAY = [0] as const;
export const WEEKLY_EVENT_DAYS: Readonly<Record<string, readonly number[]>> = {
  '01:00': ALL_WEEK,
  '09:00': ALL_WEEK,
  '11:00': SUNDAY,
  '11:30': SUNDAY,
  '12:00': SUNDAY,
  '13:00': SUNDAY,
  '13:30': SUNDAY,
  '14:00': SUNDAY,
  '14:30': SUNDAY,
  '15:00': ALL_WEEK,
  '15:30': SUNDAY,
  '16:00': SUNDAY,
  '17:00': SUNDAY,
  '17:30': SUNDAY,
  '18:00': SUNDAY,
  '18:30': SUNDAY,
  '19:00': ALL_WEEK,
  '19:30': ALL_WEEK,
  '20:00': ALL_WEEK,
  '21:00': ALL_WEEK,
  '21:30': SUNDAY,
  '22:00': ALL_WEEK,
  '22:30': SUNDAY,
  '23:00': ALL_WEEK,
};

/** Every half hour a weekly event holds on at least one day, in order. */
export const WEEKLY_EVENT_SLOTS: readonly string[] = Object.keys(WEEKLY_EVENT_DAYS).sort();

/**
 * Every satellite starts on a :15 or a :45 (Dan 2026-10-16: "ALL SATELLITES
 * SHOULD START AT THE :15 OR :45"). These are the slots the clubs' satellite
 * schedules use; none is ever a :00 or :30.
 */
export const SATELLITE_MINUTES: readonly string[] = ['15', '45'];

/** The first and last real start of the day, Chicago; nothing runs in between overnight. */
export const BOARD_DAY_OPENS = '08:00';
export const BOARD_DAY_CLOSES = '01:00';

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
    retiredStartTimes?: string[];
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
    days_of_week: [...(event.days ?? EVERY_DAY)],
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
            ...(event.retiredTimes ? { retiredStartTimes: [...event.retiredTimes] } : {}),
            startTimesEffectiveFrom: FIXED_BOARD_TIMES_EFFECTIVE_FROM,
          }
        : event.startsFrom
          ? { previousStartTimes: [], startTimesEffectiveFrom: event.startsFrom }
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
        sameOptionalList(anchor.config?.retiredStartTimes, want.config.retiredStartTimes) &&
        anchor.config?.startTimesEffectiveFrom === want.config.startTimesEffectiveFrom;
      if (!current) plan.updates.push({ id: anchor.id, row: want });
    }
  }
  for (const r of existing) {
    if (r.active && !kept.has(r.id)) plan.deactivate.push(r.id);
  }
  return plan;
}
