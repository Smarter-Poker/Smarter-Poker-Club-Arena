/**
 * Maximum seats per game variant.
 *
 * Dan, 2026-08-19:
 *   "YOU CAN'T HAVE 8 MAX PLO6. ITS ALWAYS 6 MAX FOR PLO 6 AND 7 MAX FOR PLO5"
 *   "YOU NEED TO CHANGE THESE TO ALLOW FOR RUNNING IT MULTIPLE TIMES, SO YOU
 *    CAN'T HAVE THAT MANY SEATS FOR THE PLO5, AND PLO 6 GAMES."
 *   "OR RUNNING IT 3 TIMES..."
 *
 * THE CAP IS DERIVED, NOT DECLARED.
 *
 * A first pass at this hardcoded 6 and 7 — the most seats that still leave
 * enough cards for one board. That was the wrong ceiling: Run It Twice deals
 * up to THREE independent boards out of what the deal left behind, and the
 * worst case is a PREFLOP all-in, where no board exists yet and every run
 * needs a full five cards. Those caps cleared three runs by one and two cards
 * respectively — arithmetically true, but not a margin, and rabbit hunt draws
 * from the same remainder.
 *
 * So the seat count is computed from the deck instead of asserted:
 *
 *     hole cards for a full table  +  3 boards  +  a spare board  <=  deck
 *
 * which leaves at least 20 cards after the deal: 15 for the three runs, and a
 * fourth board's worth of headroom so nothing else that touches the remaining
 * deck can push a legitimate run-it-three-times over the edge.
 *
 *   plo6  32/6 -> 5 seats   30 dealt, 22 left (7 spare after 3 runs)
 *   plo5  32/5 -> 6 seats   30 dealt, 22 left (7 spare)
 *   plo4  32/4 -> 8 seats   32 dealt, 20 left (5 spare)
 *   plo8  32/4 -> 8 seats   same 4-card deal as plo4
 *   nlh   32/2 -> 16        clamped to full ring (9)
 *
 * Short deck is 36 cards, and the same arithmetic gives it 8.
 *
 * THIS ONLY BINDS A RUN-IT-TWICE TABLE. Dan: "BUT THIS IS ONLY IF THE TABLE IS
 * A RUN IT TWICE OR THREE TIMES TABLE, IF ITS NOT THEN YOU CAN GO TO MAX
 * POSSIBLE PLAYERS IF ITS A RUN IT ONCE TABLE." A run-once table only ever
 * needs one board, so it is capped by the house rule instead:
 *
 *              run-it-3-times          run once
 *   plo6       5  (deck-bound)         6  (house rule)
 *   plo5       6  (deck-bound)         7  (house rule)
 *   plo4       8  (deck-bound)         9  (full ring)
 *
 * The house rule is Dan's: "ITS ALWAYS 6 MAX FOR PLO 6 AND 7 MAX FOR PLO5".
 * The effective cap is whichever of the two is smaller, so both constraints
 * hold at once and neither has to know about the other.
 *
 * `PokerEngine.deal()` THROWS 'Not enough cards in deck' rather than returning
 * a short array, so an over-seated table does not degrade — it fails mid-hand.
 * Getting this ceiling right is what keeps that unreachable.
 */

export type SeatCappedVariant = string;

/** How a table's Run It Twice setting affects its seat ceiling. */
export interface SeatCapOptions {
  /**
   * Whether the table offers Run It Twice. Defaults to TRUE, because
   * `run_it_twice` defaults to true on every new table — assuming otherwise
   * would hand out seats a RIT table cannot honour.
   */
  runItTwice?: boolean;
  /** Boards a RIT table may deal. Defaults to the engine maximum of 3. */
  maxRuns?: number;
}

/**
 * Dan's house maximum per variant, independent of the deck arithmetic:
 * "ITS ALWAYS 6 MAX FOR PLO 6 AND 7 MAX FOR PLO5".
 */
const HOUSE_MAX_SEATS: Record<string, number> = {
  plo6: 6,
  plo5: 7,
};

/** Full ring — the ceiling no variant may exceed regardless of the deck maths. */
export const DEFAULT_MAX_SEATS = 9;

/** A complete board. */
export const BOARD_CARDS = 5;

/** Run It Twice tops out at three boards (RunItTwiceEngine maxRuns: 2 | 3). */
export const MAX_RIT_RUNS = 3;

/**
 * A fourth board held back. Rabbit hunt reads the same remaining deck, and a
 * cap with zero slack is one feature away from breaking.
 */
export const RESERVE_CARDS = BOARD_CARDS;

/** Cards that must survive the deal: three runs plus the reserve. */
export const REQUIRED_REMAINDER = BOARD_CARDS * MAX_RIT_RUNS + RESERVE_CARDS;

/** Hole cards dealt to each player. */
export function holeCardsForVariant(variant: SeatCappedVariant | null | undefined): number {
  const v = String(variant ?? '').toLowerCase();
  if (v.startsWith('plo6')) return 6;
  if (v.startsWith('plo5')) return 5;
  if (v.startsWith('plo')) return 4; // plo4, plo8 (hi-lo) — both four-card
  if (v.startsWith('pineapple')) return 3;
  return 2;
}

/** Cards in the deck this variant is dealt from. */
export function deckSizeForVariant(variant: SeatCappedVariant | null | undefined): number {
  return String(variant ?? '')
    .toLowerCase()
    .startsWith('short')
    ? 36
    : 52;
}

/** The house ceiling for a variant, before any deck arithmetic. */
export function houseMaxSeatsForVariant(variant: SeatCappedVariant | null | undefined): number {
  const key = String(variant ?? '').toLowerCase();
  return HOUSE_MAX_SEATS[key] ?? DEFAULT_MAX_SEATS;
}

/**
 * The hard seat ceiling for a variant.
 *
 * Two independent constraints, and the smaller wins:
 *   - the HOUSE rule (PLO6 6-max, PLO5 7-max), which always applies;
 *   - the DECK, which only bites on a Run It Twice table, because that is the
 *     only table that has to deal more than one board out of the remainder.
 */
export function maxSeatsForVariant(
  variant: SeatCappedVariant | null | undefined,
  opts: SeatCapOptions = {}
): number {
  const runItTwice = opts.runItTwice !== false;
  const runs = runItTwice ? (opts.maxRuns ?? MAX_RIT_RUNS) : 1;

  const hole = holeCardsForVariant(variant);
  const dealable = deckSizeForVariant(variant) - (BOARD_CARDS * runs + RESERVE_CARDS);
  const byDeck = Math.floor(dealable / hole);

  return Math.max(2, Math.min(DEFAULT_MAX_SEATS, houseMaxSeatsForVariant(variant), byDeck));
}

/** Cards left in the deck once a full table has been dealt in. */
export function remainderAfterDeal(variant: SeatCappedVariant, seats: number): number {
  return deckSizeForVariant(variant) - holeCardsForVariant(variant) * seats;
}

/** Can this seat count still run it `runs` times from a preflop all-in? */
export function canRunItNTimes(
  variant: SeatCappedVariant,
  seats: number,
  runs: number = MAX_RIT_RUNS
): boolean {
  return remainderAfterDeal(variant, seats) >= BOARD_CARDS * runs;
}

/** True when this seat count is legal for the variant. */
export function isSeatCountLegal(
  variant: SeatCappedVariant,
  seats: number,
  opts: SeatCapOptions = {}
): boolean {
  return seats >= 2 && seats <= maxSeatsForVariant(variant, opts);
}

/** Clamp a requested seat count into the legal range for the variant. */
export function clampSeatsForVariant(
  variant: SeatCappedVariant,
  seats: number,
  opts: SeatCapOptions = {}
): number {
  const max = maxSeatsForVariant(variant, opts);
  if (!Number.isFinite(seats) || seats < 2) return Math.min(2, max);
  return Math.min(Math.floor(seats), max);
}

/** The seat options a table-builder UI may offer for this variant. */
export function seatOptionsForVariant(
  variant: SeatCappedVariant,
  opts: SeatCapOptions = {}
): Array<{ value: number; label: string }> {
  const max = maxSeatsForVariant(variant, opts);
  return [
    { value: 2, label: 'Heads Up (2)' },
    { value: 4, label: '4-Max' },
    { value: 5, label: '5-Max' },
    { value: 6, label: '6-Max' },
    { value: 7, label: '7-Max' },
    { value: 8, label: '8-Max' },
    { value: 9, label: 'Full Ring (9)' },
  ].filter((o) => o.value <= max);
}
