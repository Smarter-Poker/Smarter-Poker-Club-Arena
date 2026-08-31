/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ENGINE SEATS YOU; THE CLIENT MUST RENDER THAT SEAT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage on 2026-08-31, the same day it was written, because
 * the inline version carried a defect that only fires on the RESCUE path — the
 * one place a bug is least acceptable.
 *
 * THE BUG THIS FILE EXISTS TO MAKE IMPOSSIBLE. The healing update read:
 *
 *     setTableState((prev) => {
 *       if (prev.players[seat - 1]?.id === userId) return prev;   // never true
 *       const players = [...prev.players];
 *       while (players.length < seat) players.push(null);
 *       return { ...prev, players, ... };                          // always new
 *     });
 *
 * The heal grows the array with NULL rows; it never places the hero row (it
 * cannot — it holds a seat number, not a player). So the early-return guard
 * could never become true, every pass produced a fresh `players` identity, the
 * effect's dependencies changed, and it ran again: an infinite render loop,
 * armed precisely when a player is stranded and most needs the page to work.
 *
 * The repair is not a smarter guard, it is a shape that cannot hold this class
 * of bug: a PURE function returning `null` when nothing needs to change.
 * Idempotence becomes a property the tests pin (`heroSeatReconcile.test.ts`)
 * rather than a comment asking the reader to trust an inline reducer buried in
 * a 20,000-line component.
 */

import { MAX_SUPPORTED_SEATS } from './tableSeatGeometry';

/** The slice of table state this reconciliation reads. */
export interface HeroSeatReconcileInput {
  /** Per-seat rows, index = seat - 1. A null is an empty seat. */
  players: ReadonlyArray<{ id?: string } | null>;
  /** Seats the client currently believes the table has. */
  maxPlayers: number;
  /** The seat the client believes the hero holds; 0 when none. */
  heroSeat: number;
}

/** The minimal change required, or null when the client already agrees. */
export interface HeroSeatReconcilePatch {
  players?: (unknown | null)[];
  maxPlayers?: number;
  heroSeat?: number;
}

/**
 * A hard ceiling on how far this will grow an array.
 *
 * The seat number arrives over the network. Without a bound, one corrupt or
 * hostile payload (`seat: 1e9`) would have the client allocate a billion rows
 * and hang the tab — turning a rendering disagreement into a denial of service.
 *
 * RE-EXPORTED FROM THE LAYOUTS, NOT REDECLARED (2026-08-31 audit). The first
 * version of this file wrote `= 10` as its own literal, "for headroom", while
 * SEAT_LAYOUTS stops at 9 — so a ten-seat table would have grown ten rows of
 * state against nine drawable positions, and seat 10 would have existed and
 * rendered nowhere. That is precisely the defect this module was written to
 * prevent, reintroduced one layer up by a number copied out of its source.
 * The bound now IS the number of rings that exist.
 */
export { MAX_SUPPORTED_SEATS } from './tableSeatGeometry';

/**
 * Decide what — if anything — must change so the client renders the seat the
 * engine says this user occupies.
 *
 * Returns `null` when the client already agrees, which is the overwhelmingly
 * common case and the reason this is safe to call on every snapshot.
 *
 * GROW ONLY, NEVER TRIM. A null row renders an empty seat; a dropped row
 * erases a player. Those two failure modes are not comparable, so this only
 * ever makes the array longer.
 */
export function reconcileHeroSeatFromEngine(
  prev: HeroSeatReconcileInput,
  engineSeat: number,
  userId: string
): HeroSeatReconcilePatch | null {
  if (!userId || !Number.isInteger(engineSeat)) return null;
  if (engineSeat < 1 || engineSeat > MAX_SUPPORTED_SEATS) return null;

  // Already rendered in the seat the engine named: nothing to do. This is the
  // condition that ends the cycle once any path puts the hero row in place.
  if (prev.players[engineSeat - 1]?.id === userId) return null;

  const needsRows = prev.players.length < engineSeat;
  const needsSeats = prev.maxPlayers < engineSeat;
  /* Only ADOPT an unclaimed seat. When the client already believes the hero
     holds some other seat, that belief came from a path with its own proof
     (the seat-stolen check, the table_seats load), and overruling it from here
     would leave two writers arguing on every snapshot. The disagreement is
     still never silent — the call site reports it either way. */
  const needsHero = prev.heroSeat <= 0;

  if (!needsRows && !needsSeats && !needsHero) return null;

  const patch: HeroSeatReconcilePatch = {};
  if (needsRows) {
    const players = [...prev.players] as (unknown | null)[];
    while (players.length < engineSeat) players.push(null);
    patch.players = players;
  }
  if (needsSeats) patch.maxPlayers = engineSeat;
  if (needsHero) patch.heroSeat = engineSeat;
  return patch;
}
