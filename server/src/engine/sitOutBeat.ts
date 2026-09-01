/**
 * =========================================================================
 *  A SAT-OUT SEAT ACTS ON THE SAME BEAT AS EVERY OTHER SEAT
 * =========================================================================
 *
 * `DisconnectEngine.onPlayerTurn` folded a sitting-out player the instant the
 * action reached them - `executeAutoAction(...)` called straight from the
 * branch, zero milliseconds. Every other action on this platform has a
 * deliberate beat: a horse floors at 350 ms free and 1,250 ms facing a bet
 * (HorseLogic V24 floors), a pre-action waits 900 ms, a settle waits 650 ms.
 *
 * WHY THAT IS A BUG AND NOT A DETAIL. Dan, 2026-08-27, binding:
 *
 *   "TIMING IS PART OF THE TREATMENT. The tell is never one hand, it is the
 *    RHYTHM: a table that stops for five seconds when one seat busts and
 *    rolls straight on when another has just told every watching player which
 *    seats are horses."
 *
 * The same argument in the opposite direction applies here. Heads-up against
 * a disconnected opponent, every hand resolved at machine speed - which tells
 * the player still at the table exactly what happened to the other one, and
 * runs the level clock down on a player who cannot act. Two seats, two-minute
 * levels: a thirty-second signal drop is a lost buy-in dealt at a speed no
 * human table has ever run at.
 *
 * The beats below are deliberately the SAME two floors a horse uses, so a
 * sat-out seat is not identifiable by its rhythm. The jitter is what stops a
 * fixed value from becoming its own tell over a few hundred hands.
 *
 * Pure, so the range is pinned without timers.
 */

/** HorseLogic V24 floors, matched on purpose. Do not drift them apart. */
export const SIT_OUT_FREE_BEAT_MS = 350;
export const SIT_OUT_FACING_BEAT_MS = 1250;

/**
 * Spread, added on top of the floor. Small enough that the beat still reads
 * as one decision, wide enough that the value is not a constant.
 */
export const SIT_OUT_BEAT_JITTER_MS = 350;

/**
 * How long to wait before auto-acting for a seat that is sitting out.
 *
 * `canCheck` is the same flag the auto-action itself is given: a seat that can
 * check is making a free decision and gets the free floor; a seat facing a bet
 * is folding to money and gets the longer one.
 */
export function sitOutAutoActionDelayMs(
  canCheck: boolean,
  rand: () => number = Math.random
): number {
  const floor = canCheck ? SIT_OUT_FREE_BEAT_MS : SIT_OUT_FACING_BEAT_MS;
  const spread = Math.max(0, Math.min(1, rand())) * SIT_OUT_BEAT_JITTER_MS;
  return Math.round(floor + spread);
}
