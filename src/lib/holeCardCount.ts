/**
 * How many hole cards a variant deals.
 *
 * WHY THIS EXISTS, AND WHY IT IS A COPY
 * -------------------------------------
 * The engine is the authority. It decides the real number in
 * `ServerTableEngineDealing.ts`:
 *
 *     const CARDS_PER_PLAYER: Record<string, number> = {
 *       plo4: 4, plo5: 5, plo6: 6, plo8: 4, pineapple: 3,
 *     };
 *     const cardsPerPlayer = CARDS_PER_PLAYER[variantKey] ?? 2;
 *
 * That map is a LOCAL CONST INSIDE A METHOD. It is not exported, and even if it
 * were, `server/` is a separate build that must never be pulled into the browser
 * bundle. So the client cannot share it and has to carry its own copy.
 *
 * A copy nobody checks is how two numbers drift, so `holeCardCount.test.ts` pins
 * every value against the list above. If the engine ever adds a variant, that
 * test is where you find out.
 *
 * WHAT IT IS FOR
 * --------------
 * ONLY for drawing the right number of face-down backs on a seat whose hand we
 * cannot see. Dan 2026-08-23: "it only shows 2 cards even if its a 4 card, 5
 * card or 6 card game." An opponent's `holeCards` array is empty precisely
 * because the hand is hidden, so there is nothing local to count and the seat
 * had no way to know. Two backs were drawn on a PLO6 table.
 *
 * It is NOT used to deal, validate or evaluate anything. A wrong number here
 * draws the wrong number of rectangles; it can never affect a hand.
 */

/**
 * Keyed on the LOWERCASED variant string. The engine lowercases
 * `tableInfo.game_variant` before its lookup and this must match, because the
 * client's `tableState.gameType` arrives uppercase ('PLO4') while the database
 * column is lowercase ('plo4') - two spellings meeting is exactly the kind of
 * seam that produces a silent fallback to 2.
 */
const CARDS_PER_PLAYER: Readonly<Record<string, number>> = {
  plo4: 4,
  plo5: 5,
  plo6: 6,
  plo8: 4,
  // 2026-08-23: flo8 (Fixed Limit Omaha Hi-Lo) is four cards like every other
  // Omaha. It is spelled without "plo", which is exactly how it slipped past
  // five separate substring tests in the engine and got dealt two.
  flo8: 4,
  pineapple: 3,
};

/** Hold'em, Short Deck and anything unrecognised. Mirrors the engine's `?? 2`. */
export const DEFAULT_HOLE_CARDS = 2;

/**
 * Hole cards dealt by `variant`, or 2 for Hold'em, Short Deck and any variant
 * this map has not been taught yet.
 *
 * Falling back to 2 rather than throwing is deliberate: an unknown variant
 * string should draw a plausible hand, not blow up a seat. The engine makes the
 * same choice for the same reason.
 */
export function holeCardCountFor(variant: string | null | undefined): number {
  if (!variant) return DEFAULT_HOLE_CARDS;
  return CARDS_PER_PLAYER[variant.toLowerCase()] ?? DEFAULT_HOLE_CARDS;
}
