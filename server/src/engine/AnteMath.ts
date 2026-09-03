/**
 * ANTE ARITHMETIC — one resolver, because two callers were guessing (2026-08-30)
 *
 * `ante` on a table means one of two things and the schema does not say which:
 *
 *   PER-PLAYER  every player owes `ante` each hand. Authored as ~0.1 x BB, so
 *               a ten-handed table collects about one big blind. 10,301
 *               tournaments use this, and it is the convention both callers
 *               below have always implemented.
 *   TOTAL       `ante` IS the whole big blind ante, posted once by the BB.
 *               Authored as exactly 1 x BB, which is the modern standard.
 *               2 tournaments use this.
 *
 * HandController multiplied by the seat count unconditionally, so a structure
 * written the second way charged the big blind ONE BIG BLIND PER SEAT.
 * Measured live on 2026-08-30 in "Sunday $200 Deep Stack" (big_blind_ante on,
 * every level authoring ante == bigBlind): at a 1,000 big blind the ante taken
 * was 7,000-8,000 chips per hand. Seven to eight big blinds, every hand.
 *
 * That is not a tuning problem, it is a broken tournament: stacks drain in a
 * few orbits, and the horse brain -- which derives Harrington M from the same
 * orbit cost, carrying the same per-player assumption independently -- read M
 * as about 3 at forty big blinds and correctly turned the whole game into
 * jam-or-fold. Dan saw the symptom before anyone saw the cause: no sized
 * three-bets in tournaments, and open shoves 40 to 70 big blinds deep.
 *
 * Fixing one caller alone fixes nothing. The engine would collect the right
 * ante while the brain still believed an orbit cost 11.5bb, so the horses
 * would have gone on shoving into a table that no longer justified it. Hence
 * one function, both callers.
 *
 * The two readings are distinguishable, because nobody charges every player a
 * FULL big blind as an ante on top of the blinds. So `ante >= bigBlind` means
 * the structure authored a total, and anything below it is per-player.
 *
 * CEILING_BB is the backstop for a structure that is neither -- an ante of,
 * say, 0.5 x BB per player would read as per-player and still collect five big
 * blinds a hand. A big blind ante is one big blind by definition; two is the
 * most generous reading of any real structure. It changes nothing for the
 * conventions actually in use (0.100 x BB -> 1.00 BB at ten seats,
 * 0.125 x BB -> 1.25 BB, both under the ceiling).
 */

/** The most a big blind ante may ever collect, as a multiple of the BB. */
export const BBA_CEILING_BB = 2;

/**
 * Total chips a BIG BLIND ANTE collects for one hand — the amount the big
 * blind fronts on behalf of the whole table.
 *
 * Returns 0 when there is no ante, so the caller can skip the posting.
 */
export function bigBlindAnteTotal(ante: number, seats: number, bigBlind: number): number {
  if (!(ante > 0) || !(seats > 0)) return 0;
  // `ante >= bigBlind` is only ever written by a structure that means the total
  const authoredAsTotal = bigBlind > 0 && ante >= bigBlind;
  const total = authoredAsTotal ? ante : ante * seats;
  if (!(bigBlind > 0)) return total;
  return Math.min(total, bigBlind * BBA_CEILING_BB);
}

/**
 * Ante cost of ONE ORBIT in big blinds — the figure Harrington's M divides by,
 * alongside the blinds themselves.
 *
 * The two ante styles cost a given seat the same amount per orbit by different
 * routes, and this is the only place that difference is resolved:
 *
 *   PER-PLAYER  pay `ante` every hand -> `ante x seats` per orbit.
 *   BIG BLIND   pay the whole table's ante once per orbit, in the big blind ->
 *               the BBA total, exactly once.
 *
 * Reading the second case with the first case's formula is what made a 39bb
 * stack look like an M of 3.
 */
export function anteOrbitCostBB(
  anteChips: number,
  seats: number,
  bigBlind: number,
  bigBlindAnte: boolean
): number {
  if (!(anteChips > 0) || !(seats > 0) || !(bigBlind > 0)) return 0;
  if (bigBlindAnte) return bigBlindAnteTotal(anteChips, seats, bigBlind) / bigBlind;
  return (anteChips * seats) / bigBlind;
}
