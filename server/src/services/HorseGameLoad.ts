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

/** One `tournament_players` row that clause (2) would count. */
export interface BookingRow {
  user_id: string;
  tournament_id: string;
}

export interface GameLoad {
  /** Live seats: clause (1). */
  seats: number;
  /** Bookings that are not already described by a seat: clause (2). */
  bookings: number;
  /** The horse's OWN cash-table ceiling (its tag, never above the platform's
   *  four). A separate, softer rule about how many CASH tables it plays; it
   *  is not the platform limit and is not applied to bookings. */
  ownCashCeiling: number;
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
 */
export function buildBookingLoad(
  bookings: readonly BookingRow[],
  tournamentByTableId: ReadonlyMap<string, string>,
  seatsByPlayer: ReadonlyMap<string, ReadonlySet<string>>
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
  const seats = Math.max(0, Math.floor(load.seats));
  const byOwnCeiling = Math.max(0, Math.floor(load.ownCashCeiling) - seats);
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
