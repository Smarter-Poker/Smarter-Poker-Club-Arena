/**
 * Maximum seats per game variant — the house law. CASH GAMES ONLY.
 *
 * Dan, 2026-08-19:
 *   "PLO5 CARD IS 7 PLAYERS MAX, AND PLO6 CARD IS 6 PLAYERS MAX BY DEFAULT.
 *    PLO4 IS 8 PLAYERS MAX BY DEFAULT. MAKE THIS LAW FOR ALL GAMES"
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * The law was written into src/config/tableSeating.ts and enforced in
 * TableService.createTable — the path the club's Create Table modal uses. That
 * covered every table a HUMAN makes and none of the tables the ENGINE makes.
 * HorseFleetManager.DEFAULT_TABLES creates the cash tables the fleet plays on,
 * runs inside server/, and had its own hardcoded seat counts:
 *
 *   PLO5 1.00/2.00   maxPlayers: 8   (the law says 7)
 *   PLO6 1.00/2.00   maxPlayers: 7   (the law says 6)
 *
 * Those tables were live. Six of them were sitting in production when this was
 * found, created that same hour, and the fleet re-created them on every boot.
 *
 * This is not cosmetic. server/src/engine/HandController.ts and
 * ServerTableEngineRunout.ts both carry comments reasoning that they need not
 * defend against deck exhaustion BECAUSE "PLO6 is 6-max and PLO5 is 7-max".
 * That assumption was false in production. PLO5 at 8 leaves 12 cards, PLO6 at
 * 7 leaves 10 — and `PokerEngine.deal()` THROWS 'Not enough cards in deck'
 * rather than returning a short array, so Run It Twice on a full table did not
 * degrade, it failed mid-hand.
 *
 * WHY IT IS A COPY AND NOT AN IMPORT.
 *
 * server/tsconfig.json sets rootDir './src', so server code cannot import from
 * ../../src without changing the compiled output layout of a live engine. The
 * repo already has this exact problem with the rake schedule and already has
 * the answer: declare it twice, and make CI fail if the two copies disagree.
 * scripts/ci/check-seat-law-parity.mjs is that gate, and it is blocking. Edit
 * one copy without the other and the build goes red.
 *
 * TOURNAMENTS ARE NOT BOUND BY THIS — see the header of src/config/tableSeating.ts.
 * A Spin & Go is 3-max because it is a Spin & Go; an MTT is full ring. Nothing
 * here may be applied to a table with a tournament_id.
 */

/** Full ring — the cap for any variant without a tighter rule. */
export const DEFAULT_MAX_SEATS = 9;

/** Dan's law. One number per variant. Mirrors src/config/tableSeating.ts. */
const MAX_SEATS_BY_VARIANT: Record<string, number> = {
  plo6: 6,
  plo5: 7,
  plo4: 8,
  plo8: 8, // four-card hi-lo — same deal as plo4
  // 2026-08-24: flo8 is Fixed Limit Omaha Hi-Lo — the SAME four-card deal as
  // plo8. Only the betting differs, and betting does not change how many cards
  // leave the deck. Kept in step with the client copy by check-seat-law-parity.
  flo8: 8,
};

/** The hard seat ceiling for a variant. */
export function maxSeatsForVariant(variant: string | null | undefined): number {
  const key = String(variant ?? '').toLowerCase();
  return MAX_SEATS_BY_VARIANT[key] ?? DEFAULT_MAX_SEATS;
}

/** True when this seat count is legal for the variant. */
export function isSeatCountLegal(variant: string | null | undefined, seats: number): boolean {
  return seats >= 2 && seats <= maxSeatsForVariant(variant);
}

/**
 * Clamp a requested seat count into the legal range for the variant.
 *
 * Every server-side CASH table insert runs its seat count through this, so a
 * config array that drifts from the law cannot reach the database. The config
 * being wrong then costs a seat, not a thrown deal.
 */
export function clampSeatsForVariant(variant: string | null | undefined, seats: number): number {
  const max = maxSeatsForVariant(variant);
  if (!Number.isFinite(seats) || seats < 2) return Math.min(2, max);
  return Math.min(Math.floor(seats), max);
}
