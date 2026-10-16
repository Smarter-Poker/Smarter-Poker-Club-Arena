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
  /** Field head start the scheduler gives an event inside its last hour. */
  horses: number;
}

export const FIXED_BOARD: readonly FixedBoardEvent[] = [
  { name: 'Midnight Free Buy (NLH)', times: ['00:00'], horses: 0 },
  { name: 'Morning Free Buy (NLH)', times: ['08:00'], horses: 0 },
  { name: 'Midday Free Buy (NLH)', times: ['12:00'], horses: 0 },
  { name: 'Afternoon Free Buy (NLH)', times: ['16:00'], horses: 0 },
  { name: 'Prime Time Free Buy (NLH)', times: ['20:00'], horses: 0 },
  { name: 'Early Bird Freeroll (NLH)', times: ['22:30', '23:45', '01:00'], horses: 20 },
  { name: 'Pre-Dawn Mystery Bounty (PLO5)', times: ['22:30', '23:45', '01:00'], horses: 15 },
  { name: 'Sunrise Bounty (NLH)', times: ['01:30', '02:50', '04:10'], horses: 16 },
  { name: 'Morning Grinder (PLO)', times: ['01:30', '02:50', '04:10'], horses: 14 },
  { name: 'Mid-Morning Turbo (6-Max NLH)', times: ['04:30', '05:50', '07:10'], horses: 12 },
  { name: 'Brunch Special PKO (PLO8)', times: ['04:30', '05:50', '07:10'], horses: 15 },
  { name: 'Union Morning Classic (NLH)', times: ['05:30'], horses: 20 },
  { name: 'Lunch Rush (NLH Deep)', times: ['07:30'], horses: 20 },
  { name: 'Union PKO Afternoon (PLO4)', times: ['09:30'], horses: 18 },
  { name: 'Afternoon Bounty (NLH)', times: ['10:30', '11:50', '13:10'], horses: 18 },
  { name: 'Coffee Break Freeroll (PLO4)', times: ['10:30', '11:45', '13:00'], horses: 14 },
  { name: 'Prime Time Main Event (NLH)', times: ['13:30'], horses: 30 },
  { name: 'Evening Mystery Bounty (PLO5)', times: ['13:30', '14:50', '16:10'], horses: 18 },
  { name: 'Union Grand Championship (NLH)', times: ['14:30'], horses: 30 },
  { name: 'Union Mystery Bounty (PLO5)', times: ['14:30', '15:50'], horses: 22 },
  { name: 'Night Owl Special (NLH)', times: ['16:30', '17:50', '19:10'], horses: 25 },
  { name: 'Late Night PKO (PLO4)', times: ['16:30', '17:50', '19:10'], horses: 20 },
  { name: 'Union Late Night Turbo (NLH)', times: ['17:30', '18:50'], horses: 16 },
  { name: 'Late Night Grind (PLO4)', times: ['19:30', '20:40', '21:50'], horses: 10 },
  { name: 'Midnight Bounty (NLH)', times: ['19:30', '20:45', '22:00'], horses: 12 },
];

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
  config: { type: 'fixed_board'; fixedBoard: string; horsesToRegister: number };
}

export function fixedBoardRowFor(club: FixedBoardClub, event: FixedBoardEvent): FixedBoardRow {
  return {
    club_id: club.clubId,
    union_id: club.unionId,
    name: event.name,
    description: 'Fixed daily board',
    active: true,
    days_of_week: [...EVERY_DAY],
    start_times_utc: [...event.times],
    interval_minutes: null,
    time_zone: FIXED_BOARD_TIME_ZONE,
    config: { type: 'fixed_board', fixedBoard: event.name, horsesToRegister: event.horses },
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
        anchor.config?.horsesToRegister === want.config.horsesToRegister;
      if (!current) plan.updates.push({ id: anchor.id, row: want });
    }
  }
  for (const r of existing) {
    if (r.active && !kept.has(r.id)) plan.deactivate.push(r.id);
  }
  return plan;
}
