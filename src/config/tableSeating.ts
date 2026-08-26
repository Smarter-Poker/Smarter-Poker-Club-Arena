/**
 * Maximum seats per game variant — the house law. CASH GAMES ONLY.
 *
 * Dan, 2026-08-19:
 *   "PLO5 CARD IS 7 PLAYERS MAX, AND PLO6 CARD IS 6 PLAYERS MAX BY DEFAULT.
 *    PLO4 IS 8 PLAYERS MAX BY DEFAULT. MAKE THIS LAW FOR ALL GAMES"
 *   "...WHAT I GAVE YOU WAS FOR CASH GAMES ONLY, YOU CAN NOT RUN IT TWO OR
 *    THREE TIMES IN A TOURNAMENT"
 *
 * TOURNAMENTS ARE NOT BOUND BY THIS. The whole reason the cash cap is tight is
 * Run It Twice — three boards have to come out of what the deal left behind.
 * Tournaments cannot run it twice at all, so they need room for ONE board and
 * size their tables from their own structure instead: a Spin & Go is 3-max
 * because it is a Spin & Go, an SNG is its own max_players, an MTT is full
 * ring. Applying this law to them would shrink 9-handed MTT tables and turn
 * 3-max Spin & Gos into 8-max, which is a structural change, not a seat cap.
 *
 * `TableService.createTable` is the cash path (the club's Create Table modal is
 * its only caller); tournament tables are built server-side by
 * TournamentRecurringService and friends, and must stay that way.
 *
 *   plo6   6      plo5   7      plo4 / plo8   8      everything else   9
 *
 * FLAT, NOT CONDITIONAL. An earlier version made the cap depend on whether the
 * table had Run It Twice enabled, which produced two numbers per variant and a
 * seat count that moved when a toggle moved. Dan replaced it with one number
 * per variant. A single answer to "how many seats can this game have" is worth
 * more than squeezing an extra seat out of a run-once table.
 *
 * THE ARITHMETIC STILL HOLDS. Hole cards and every board come out of one deck,
 * and Run It Twice deals up to THREE boards from whatever the deal left behind
 * — worst case a preflop all-in, where each run needs a full five cards:
 *
 *   plo6 @ 6   36 dealt, 16 left, 15 needed for 3 runs   (1 spare)
 *   plo5 @ 7   35 dealt, 17 left, 15 needed              (2 spare)
 *   plo4 @ 8   32 dealt, 20 left, 15 needed              (5 spare)
 *   plo8 @ 8   32 dealt, 20 left, 15 needed              (5 spare)
 *   nlh  @ 9   18 dealt, 34 left                        (19 spare)
 *
 * Three runs fit at every cap. plo6 and plo5 are tight — one and two cards —
 * so anything added later that draws from the remaining deck (rabbit hunt
 * already does) must be checked against this table, not assumed to fit.
 * `assertRunItThreeTimesFits()` below is the check, and a test calls it for
 * every variant so the margin can never silently go negative.
 *
 * `PokerEngine.deal()` THROWS 'Not enough cards in deck' rather than returning
 * a short array, so an over-seated table does not degrade — it fails mid-hand.
 */

export type SeatCappedVariant = string;

/** Full ring — the cap for any variant without a tighter rule. */
export const DEFAULT_MAX_SEATS = 9;

/** A complete board. */
export const BOARD_CARDS = 5;

/** Run It Twice tops out at three boards (RunItTwiceEngine maxRuns: 2 | 3). */
export const MAX_RIT_RUNS = 3;

/** Dan's law. One number per variant. */
const MAX_SEATS_BY_VARIANT: Record<string, number> = {
  plo6: 6,
  plo5: 7,
  plo4: 8,
  plo8: 8, // four-card hi-lo — same deal as plo4
  // 2026-08-24: flo8 is Fixed Limit Omaha Hi-Lo — the SAME four-card deal as
  // plo8. Only the betting differs, and betting does not change how many cards
  // leave the deck. Without this line it fell to DEFAULT_MAX_SEATS and a
  // nine-seat FLO8 table was creatable where a nine-seat PLO8 was not.
  flo8: 8,
};

/** Hole cards dealt to each player. */
const HOLE_CARDS_BY_VARIANT: Record<string, number> = {
  nlh: 2,
  flh: 2,
  short_deck: 2,
  pineapple: 3,
  plo4: 4,
  plo5: 5,
  plo6: 6,
  plo8: 4,
  flo8: 4,
};

export function holeCardsForVariant(variant: SeatCappedVariant | null | undefined): number {
  // 2026-08-24: this was four `startsWith` tests with `return 2` underneath.
  // `flo8` — Fixed Limit Omaha Hi-Lo — starts with none of them, so a four-card
  // game reported TWO hole cards and `remainderAfterDeal` overstated the deck
  // by 18 cards at a full table. That is the sixth copy of this same guess to
  // be found (the other five were in the engine; see
  // server/src/engine/VariantRules.ts, which is the authority this mirrors).
  // A table beats a prefix test: a variant is either listed or it is Hold'em,
  // and adding one cannot silently mean "two cards" any more.
  const v = String(variant ?? '').toLowerCase();
  return HOLE_CARDS_BY_VARIANT[v] ?? 2;
}

/** Cards in the deck this variant is dealt from. */
export function deckSizeForVariant(variant: SeatCappedVariant | null | undefined): number {
  return String(variant ?? '')
    .toLowerCase()
    .startsWith('short')
    ? 36
    : 52;
}

/** The hard seat ceiling for a variant. */
export function maxSeatsForVariant(variant: SeatCappedVariant | null | undefined): number {
  const key = String(variant ?? '').toLowerCase();
  return MAX_SEATS_BY_VARIANT[key] ?? DEFAULT_MAX_SEATS;
}

/**
 * The most seats the DECK can physically serve: every hole card, plus a board.
 *
 * This is PHYSICS, not the house law above, and the two are different numbers
 * on purpose. `maxSeatsForVariant` is Dan's CASH cap, kept tight so Run It
 * Twice has three boards to come out of. Tournaments are explicitly exempt from
 * that — see the header — because they cannot run it twice, they size their
 * tables from their own structure, and capping them would shrink 9-handed MTTs
 * and turn 3-max Spin & Gos into 8-max.
 *
 * They are NOT exempt from the deck. `PokerEngine.deal()` throws rather than
 * dealing short, so an over-seated table does not degrade — it fails mid-hand.
 * This is the only ceiling a tournament needs, and the only one it gets.
 *
 *   nlh / flh 23   short_deck 15   pineapple 15
 *   plo4 / plo8 / flo8 11   plo5 9   plo6 7
 */
export function maxSeatsTheDeckAllows(variant: SeatCappedVariant | null | undefined): number {
  return Math.floor((deckSizeForVariant(variant) - BOARD_CARDS) / holeCardsForVariant(variant));
}

/** Cards left in the deck once a full table has been dealt in. */

export function remainderAfterDeal(variant: SeatCappedVariant, seats: number): number {
  return deckSizeForVariant(variant) - holeCardsForVariant(variant) * seats;
}

/** Can a full table at `seats` still run it `runs` times from a preflop all-in? */
export function canRunItNTimes(
  variant: SeatCappedVariant,
  seats: number,
  runs: number = MAX_RIT_RUNS
): boolean {
  return remainderAfterDeal(variant, seats) >= BOARD_CARDS * runs;
}

/**
 * Spare cards left over after a full table runs it three times. Zero or less
 * means the cap no longer fits the game — see the note at the top of the file.
 */
export function ritHeadroom(variant: SeatCappedVariant): number {
  return remainderAfterDeal(variant, maxSeatsForVariant(variant)) - BOARD_CARDS * MAX_RIT_RUNS;
}

/** True when this seat count is legal for the variant. */
export function isSeatCountLegal(variant: SeatCappedVariant, seats: number): boolean {
  return seats >= 2 && seats <= maxSeatsForVariant(variant);
}

/** Clamp a requested seat count into the legal range for the variant. */
export function clampSeatsForVariant(variant: SeatCappedVariant, seats: number): number {
  const max = maxSeatsForVariant(variant);
  if (!Number.isFinite(seats) || seats < 2) return Math.min(2, max);
  return Math.min(Math.floor(seats), max);
}

/** The seat options a table-builder UI may offer for this variant. */
export function seatOptionsForVariant(
  variant: SeatCappedVariant
): Array<{ value: number; label: string }> {
  const max = maxSeatsForVariant(variant);
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
