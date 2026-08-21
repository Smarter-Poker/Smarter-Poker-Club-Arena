/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHEN IS A HAND ACTUALLY OVER? (Dan's law, 2026-08-21)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verbatim: "A HAND IS NOT COMPLETED, UNTIL THE WINNING HAND IS SHOWN AT SHOW
 * DOWN AND IDENTIFIED, THE PUSH POT ANIMATION, WITH THE POT TOTAL HAS RAN. AND
 * ACTUALLY PUSHED THE POT TO THE WINNER, THAT THE CARDS AND THE CARDS AT
 * SHOWDOWN ARE MUCKED. IF THERE IS NO SHOW DOWN, THE HAND IS NOT COMPLETED
 * UNTIL THE PUSH POT ANIMATION, WITH THE POT TOTAL HAS RAN. AND ACTUALLY
 * PUSHED THE POT TO THE WINNER, THAT THE CARDS ARE MUCKED. THE NEXT HAND
 * STARTS WITH THE DEALING CARDS ANIMATION."
 *
 * A hand ends in BEATS, not on a stopwatch. The engine may not deal the next
 * hand until every beat below has actually played:
 *
 *   1. SHOWDOWN READ   (showdown only) the winning hand is face-up and named
 *   2. BETS SWEEP      the street's bets travel into the pot
 *   3. POT PUSH        the pot travels to the winner carrying its total —
 *                      the floating "+N" that rides the chips
 *   4. MUCK            the cards go to the muck
 *   5. next hand opens with the DEAL animation, never cards appearing
 *
 * WHY THIS FILE EXISTS. The engine's hold used to be three hand-written
 * numbers, and the client's animation lengths lived in CSS. Nothing tied them
 * together, so any animation change silently truncated the sequence. Live
 * example this file was written to fix: the pot-win float runs 2200ms and
 * only STARTS after the 700ms sweep — 2900ms of animation inside a 2600ms
 * hold, so the next hand was dealt over the top of the number telling you
 * what you had just won.
 *
 * The durations here ARE the animation lengths (they match TablePage.css:
 * .pot-win-float 2.2s, --pd-collect-duration, the muck and deal keyframes),
 * and the engine derives its hold from them. Change an animation, change it
 * here, and the table waits the right amount automatically.
 *
 * MIRRORED, byte-identical, at server/src/config/handCompletionSpec.ts —
 * server/tsconfig.json sets rootDir ./src so the engine cannot import from the
 * app. A test pins the two copies equal.
 */

export const HAND_COMPLETION = {
  /** Street bets sweep off the felt into the pot before the pot can travel. */
  BETS_SWEEP_MS: 700,
  /**
   * The pot travels to the winner carrying its total. Matches the
   * `.pot-win-float` / `potWinFloatRide` animation (2.2s), which is the
   * longest element of the push and the one that names the amount won.
   */
  POT_PUSH_MS: 2200,
  /** Cards fly to the muck. */
  MUCK_MS: 600,
  /** Reading a heads-up showdown: cards face-up, winning hand named. */
  SHOWDOWN_READ_BASE_MS: 1200,
  /** Each additional shown hand needs its own beat to read. */
  SHOWDOWN_READ_PER_EXTRA_HAND_MS: 700,
  /** A big multiway showdown must still not stall the table forever. */
  SHOWDOWN_READ_MAX_MS: 3000,
  /**
   * A Bad Beat Jackpot is real money and plays a ~9s full-screen celebration.
   * Nothing about a jackpot is rushed: the table waits for the whole thing.
   */
  BBJ_CELEBRATION_MS: 9000,
  /** Board/card sweep after the winner is settled. */
  BOARD_CLEAR_SHOWDOWN_MS: 900,
  BOARD_CLEAR_FOLD_MS: 500,
  /** The next hand's dealing animation (cardDealIn / heroCardDeal). */
  DEAL_MS: 700,
} as const;

export interface HandCompletionOpts {
  /** Did the hand reach a showdown (cards shown), or end on a fold? */
  wentToShowdown: boolean;
  /** How many hands were shown at showdown (2 = heads-up). */
  showdownHands?: number;
  /** Did this hand hit the Bad Beat Jackpot? */
  bbjHit?: boolean;
}

/**
 * How long the engine must hold after the winner is decided, before it may
 * deal the next hand. This is beats 1-4; the board clear is added on top by
 * `boardClearMs` so the two phases stay separately observable.
 */
export function handCompletionHoldMs(opts: HandCompletionOpts): number {
  const H = HAND_COMPLETION;
  if (opts.bbjHit) return H.BBJ_CELEBRATION_MS;

  // Beats 2-4 happen on every hand, showdown or not: the bets sweep in, the
  // pot travels with its total, the cards are mucked.
  const push = H.BETS_SWEEP_MS + H.POT_PUSH_MS + H.MUCK_MS;

  if (!opts.wentToShowdown) return push;

  const extra = Math.max(0, (opts.showdownHands ?? 2) - 2);
  const read = Math.min(
    H.SHOWDOWN_READ_MAX_MS,
    H.SHOWDOWN_READ_BASE_MS + extra * H.SHOWDOWN_READ_PER_EXTRA_HAND_MS
  );
  return read + push;
}

/** The board/card sweep that follows the hold. */
export function boardClearMs(wentToShowdown: boolean): number {
  return wentToShowdown
    ? HAND_COMPLETION.BOARD_CLEAR_SHOWDOWN_MS
    : HAND_COMPLETION.BOARD_CLEAR_FOLD_MS;
}
