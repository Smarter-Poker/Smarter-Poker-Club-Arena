/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BOOKING IS A GAME (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The database refuses a fifth concurrent game. `fn_enforce_four_table_limit`
 * fires BEFORE INSERT on `table_seats` and asks `fn_concurrent_game_load`,
 * which counts TWO things:
 *
 *   1. every live seat at a table that is not closed, and
 *   2. every booking for a tournament that has not started yet - a
 *      `tournament_players` row in `registered` or `playing` whose tournament
 *      is `ANNOUNCED` or `REGISTERING` - except where the player already
 *      holds a seat at one of that tournament's tables, because a seat-first
 *      game sells the chair before it starts and the two would describe the
 *      same game.
 *
 * The fleet counted only (1). Measured on production 2026-09-06 09:45 UTC:
 *
 *   - `FOUR TABLE LIMIT: user ... is already committed to N games` was raised
 *     10,577 times in under four hours - the single most common error on the
 *     whole database, ahead of everything else by a factor of two;
 *   - 1,000 horses: TWO were at four live seats (all the fleet could see),
 *     while 351 were at the database's four-game limit and 349 of those
 *     looked completely free to the fleet - 2,109 tournament bookings the
 *     fleet's arithmetic could not see;
 *   - opening feeders in three hours: 156 horses selected, 34 seated. 30 of
 *     51 feeder cycles seated NOBODY, and the log said nothing, because
 *     `seatHorse` treats FOUR TABLE LIMIT as an ordinary seeding race.
 *
 * The bias makes it worse than the headline 35%: the seeding loop prefers a
 * horse already playing (weight 4 against 1, "four tables is the target"),
 * and those are the horses most likely to be booked as well - 67% of horses
 * at two live seats and 89% at three were at the database's limit.
 *
 * So the fleet promised the controller buyers the database would refuse, the
 * controller opened a feeder for them, and the feeder was abandoned empty.
 *
 * THIS IS NOT A HORSE RULE (CLAUDE.md 10.5). `fn_concurrent_game_load` counts
 * a human's bookings exactly the same way, and its own HINT says so: "This
 * limit applies to players and horses alike". A human reads the lobby and
 * knows they are committed to four games; the fleet is the horse's browser,
 * and this module is how it reads the same thing. Nothing here denies a horse
 * anything a human gets - it stops the fleet offering what the database will
 * refuse, for either of them.
 *
 * Pure, so the rule can be proven without a database.
 */

/** The platform ceiling, mirroring `v_max_tables` / the `v_live >= 4` test in
 *  `fn_enforce_four_table_limit`. */
export const CONCURRENT_GAME_LIMIT = 4;

/**
 * A BOOKING IS A GAME AN HOUR BEFORE IT STARTS (2026-09-06, Dan: "PROCEED").
 *
 * Clause (2) used to count a booking from the moment it was made. Measured
 * 09:45 CDT the same day: 2,111 bookings across 897 players, 1,377 of them for
 * events more than six hours away and 466 more than a day away (the furthest
 * 68 hours), and 217 horses capped by bookings ALONE - registering for
 * Tuesday cost a cash seat until Tuesday. Migration 20260906144448 narrowed
 * the SQL to bookings whose tournament starts within sixty minutes; this is
 * the same window, applied to the same rows, so the fleet keeps counting
 * exactly what the database counts.
 *
 * A booking with NO start time is a seat-first game (a Spin, a sit-and-go)
 * that starts the moment it fills, so it always counts - as the SQL's
 * `tr.start_time IS NULL OR` does.
 *
 * The hard invariant is untouched: never more than four LIVE seats.
 */
export const BOOKING_COUNTS_WITHIN_MS = 60 * 60 * 1000;

/** Does this booking count as a game right now? Mirrors the SQL predicate
 *  `tr.start_time IS NULL OR tr.start_time <= now() + interval '60 minutes'`.
 *  An unparseable start time counts, because counting too much refuses a
 *  seat the database would also refuse, while counting too little offers the
 *  controller a buyer the door will turn away. */
export function bookingIsAGame(
  startTime: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (startTime === null || startTime === undefined || startTime === '') return true;
  const start = Date.parse(startTime);
  if (!Number.isFinite(start)) return true;
  return start <= nowMs + BOOKING_COUNTS_WITHIN_MS;
}

/** One `tournament_players` row that clause (2) would consider. `start_time`
 *  is the tournament's; absent means seat-first and always counts. */
export interface BookingRow {
  user_id: string;
  tournament_id: string;
  start_time?: string | null;
}

export interface GameLoad {
  /** Live seats, EVERY table: clause (1), and the platform limit's input. */
  seats: number;
  /** Bookings that are not already described by a seat: clause (2). */
  bookings: number;
  /** The horse's OWN cash-table ceiling (its tag, never above the platform's
   *  four). A separate, softer rule about how many CASH tables it plays; it
   *  is not the platform limit and is not applied to bookings. */
  ownCashCeiling: number;
  /** Live seats at CASH tables only - what `ownCashCeiling` is measured
   *  against. Omitted means the caller cannot tell them apart, and the
   *  ceiling then falls back to `seats` (stricter). See
   *  remainingGameCapacity. */
  cashSeats?: number;
}

/**
 * Bookings per player, counted exactly as `fn_concurrent_game_load` clause (2)
 * counts them - including the "never both" exclusion, so a player who already
 * holds a chair at a tournament that has not started is not charged twice for
 * the same game.
 *
 * `tournamentByTableId` maps every table that is not closed to its tournament;
 * `seatsByPlayer` is the fleet's live seat map. A booking whose tournament is
 * absent from the table map cannot have a seat, which is the ordinary case.
 *
 * `nowMs` is the instant the sixty-minute window is measured from
 * (`bookingIsAGame`); a booking for a tournament further out is a plan and is
 * not counted.
 */
export function buildBookingLoad(
  bookings: readonly BookingRow[],
  tournamentByTableId: ReadonlyMap<string, string>,
  seatsByPlayer: ReadonlyMap<string, ReadonlySet<string>>,
  nowMs: number = Date.now()
): Map<string, number> {
  /* player -> the tournaments they already hold a chair in. Built once, from
     the seat map, so the exclusion costs one pass rather than one per row. */
  const seatedTournaments = new Map<string, Set<string>>();
  for (const [player, tableIds] of seatsByPlayer) {
    for (const tableId of tableIds) {
      const tournamentId = tournamentByTableId.get(tableId);
      if (!tournamentId) continue;
      if (!seatedTournaments.has(player)) seatedTournaments.set(player, new Set());
      seatedTournaments.get(player)!.add(tournamentId);
    }
  }
  const out = new Map<string, number>();
  /* One row per (player, tournament): a second registration for one
     tournament is one game, not two. */
  const counted = new Set<string>();
  for (const b of bookings) {
    if (!b.user_id || !b.tournament_id) continue;
    if (!bookingIsAGame(b.start_time, nowMs)) continue;
    const key = `${b.user_id}|${b.tournament_id}`;
    if (counted.has(key)) continue;
    counted.add(key);
    if (seatedTournaments.get(b.user_id)?.has(b.tournament_id)) continue;
    out.set(b.user_id, (out.get(b.user_id) ?? 0) + 1);
  }
  return out;
}

/** Games this player is committed to right now, the database's definition. */
export function concurrentGameLoad(load: Pick<GameLoad, 'seats' | 'bookings'>): number {
  return Math.max(0, Math.floor(load.seats)) + Math.max(0, Math.floor(load.bookings));
}

/**
 * How many MORE tables the fleet may open for this player: the smaller of what
 * its own cash ceiling leaves and what the platform's four-game limit leaves.
 * Never negative.
 *
 * The two are different questions and both have to hold. The tag ceiling is
 * about cash multi-tabling and is measured against cash seats; the platform
 * limit is about everything the player is committed to and is measured
 * against seats plus bookings.
 */
export function remainingGameCapacity(load: GameLoad): number {
  /* ── THE CASH CEILING IS MEASURED AGAINST CASH SEATS (2026-09-06) ─────────
     The paragraph above has always said "measured against cash seats", and
     the code has always subtracted `load.seats` - which the fleet builds from
     `allActiveSeats`, EVERY open seat on the platform, tournament tables
     included (that read's own comment says so). So a horse whose tag says
     `max_tables: 2` and which is sitting at two tournament tables was refused
     every cash table on the floor by a rule documented as being about cash
     multi-tabling. 837 horses carry a tag of 2 or 3.

     `cashSeats` is optional because an absent value is a caller that has not
     been taught the difference, and the honest answer there is the old,
     stricter one - it refuses seats the database would allow, which is the
     safe direction to be wrong in. The fleet passes it. */
  const cashSeats = Math.max(0, Math.floor(load.cashSeats ?? load.seats));
  const byOwnCeiling = Math.max(0, Math.floor(load.ownCashCeiling) - cashSeats);
  const byPlatform = Math.max(0, CONCURRENT_GAME_LIMIT - concurrentGameLoad(load));
  return Math.min(byOwnCeiling, byPlatform);
}

/** May the fleet seat this player at one more table? */
export function mayEnterAnotherGame(load: GameLoad): boolean {
  return remainingGameCapacity(load) > 0;
}

/**
 * Which rule refused, for the cycle line. `platform` is the one that was
 * invisible until today; `own_ceiling` is the tag rule that was always there.
 */
export function refusalReason(load: GameLoad): 'platform' | 'own_ceiling' | null {
  if (mayEnterAnotherGame(load)) return null;
  return concurrentGameLoad(load) >= CONCURRENT_GAME_LIMIT ? 'platform' : 'own_ceiling';
}
