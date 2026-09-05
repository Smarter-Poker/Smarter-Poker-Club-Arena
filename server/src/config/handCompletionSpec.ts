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
  /**
   * Reading a heads-up showdown: cards face-up, winning hand named.
   *
   * Dan 2026-08-21 (item 11): "give all showdowns 3 FULL SECONDS for all cards
   * to be read by players before the pot ship animation and total size plays."
   * 1200ms covered the card-flip animation and almost nothing else — enough to
   * see that a showdown had happened, not enough to read two holdings and a
   * board. Three seconds is the floor now, and it is a FLOOR: extra hands still
   * add their own beat on top.
   *
   * `ServerTableEngineRunout.showdownSettleMs` is the sleep that actually
   * delays the pot ship and MUST match this number, or the engine deals the
   * next hand before the beat it is holding for has finished.
   */
  SHOWDOWN_READ_BASE_MS: 3000,
  /** Each additional shown hand needs its own beat to read. */
  SHOWDOWN_READ_PER_EXTRA_HAND_MS: 700,
  /** A big multiway showdown must still not stall the table forever. */
  SHOWDOWN_READ_MAX_MS: 4400,
  /**
   * SHOWDOWN SYSTEM 2026-08-25 (Dan spec section 3): per-seat stagger on the
   * showdown card flip, in reveal order — the final-street last aggressor
   * flips first, then clockwise, the way a live table hands in turn. Small
   * enough that a 4-way showdown finishes flipping well inside the
   * SHOWDOWN_READ window it must never outrun.
   */
  SHOWDOWN_REVEAL_STAGGER_MS: 300,
  /**
   * SHOWDOWN SYSTEM follow-up 2026-08-25 (Dan spec sections 16/19/20): when
   * more than one player is paid — different pots, or a chopped pot — each
   * winner's award animation (chip fan + "+N" float) starts this long after
   * the previous one, in pot order: main pot first, then each side pot. The
   * engine's Winner list is already emitted in that order (determineWinners
   * iterates pots[0..n] and distributePot appends), so the client only has
   * to respect the order it was handed. A single winner is unaffected.
   */
  POT_AWARD_STAGGER_MS: 900,
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
  /**
   * ── THE END-OF-HAND CADENCE, COMPLETED (Dan 2026-08-27) ──
   *
   * Verbatim: "IDENTIFY WINNING HAND(S), DISPLAY THE NAME OF THE WINNING
   * HAND(S), PUSH POT ANIMATION PLUS THE +XXX TOTAL ANIMATION, PAUSE 1
   * SECOND, MOVE THE BUTTON ANIMATION... START DEALING NEXT HAND."
   *
   * The first three beats already existed (SHOWDOWN_READ / POT_PUSH with the
   * riding "+N" float). These two complete the sentence:
   *
   * POST_PUSH_PAUSE_MS — one full second of rest after the pot has landed and
   * the cards are mucked, BEFORE anything about the next hand happens. The
   * engine's hold includes it, so the next hand physically cannot start
   * inside the pause.
   */
  POST_PUSH_PAUSE_MS: 1000,
  /**
   * BUTTON_MOVE_MS — the dealer puck's glide to its new seat is its own beat,
   * played by the CLIENT at HAND_STARTED (the button's new seat is only known
   * once the new hand's state arrives): the puck slides (600ms CSS transition
   * + 100ms settle) and ONLY THEN do the cards fly. TablePage delays the deal
   * animation start by this much; it is deliberately NOT part of the engine
   * hold, because adding it there would double-count the beat (the engine
   * would wait 700ms in which no client can yet know where the button goes).
   */
  BUTTON_MOVE_MS: 700,
  /**
   * ── THE DISCARD IS AN ACT, AND IT NEEDS A BEAT (Phase 3, 2026-08-31) ──
   *
   * A Crazy Pineapple discard is the only decision the variant adds, and every
   * other cadence on this table is a named number in this file. This one was
   * not: `checkPineappleDiscardsComplete` called `advanceStage()` on the same
   * synchronous tick as the last discard, so the flop's betting round opened
   * on top of the card that was still leaving somebody's hand.
   *
   * Sized from the animation it is holding for, the way every other constant
   * here is: `cardDiscardOut` in SeatSlot.css runs 420ms and SeatSlot's own
   * removal window is 500ms (both scaled by --animation-speed). 600ms clears
   * the slowest of those at speed 1 and leaves a short rest on top, so the
   * toss finishes and is SEEN to finish before the table asks anyone to act.
   *
   * Note this is the only beat in this file the ENGINE holds for an action
   * animation rather than for the end of a hand. That is because it is the
   * only animation that must finish before a betting round can legally open.
   */
  DISCARD_SETTLE_MS: 600,
  /**
   * When several seats discard inside the same instant - a table of horses,
   * or an all-in resolve - their tosses are staggered by this much so the
   * felt reads as several separate decisions rather than one flush. Same idea
   * and the same order of magnitude as SHOWDOWN_REVEAL_STAGGER_MS, and small
   * enough that a full ring's stagger still finishes inside DISCARD_SETTLE_MS.
   */
  DISCARD_STAGGER_MS: 90,
  /**
   * ── RUN IT TWICE reveal timeline (PokerBros parity, 2026-08-26) ──
   *
   * A run-it-twice hand settles synchronously on the server, but the CLIENT
   * deals the boards street by street, run by run, at the paced-runout
   * cadence — measured off Dan's reference recordings at 10fps: streets
   * ~1.3-1.4s apart, ~1.8s between boards, winner ribbons ~0.9s after the
   * last river, pots shipping ~0.9-1.2s apart. The engine derives its
   * post-hand hold from these same numbers (handCompletionHoldMs), so the
   * next hand can never deal over a board that is still being revealed.
   */
  /**
   * ALL_IN_STREET_REVEAL_MS — the gap between a run-out street reaching the
   * client and that street's new equity being allowed to change.
   *
   * Dan 2026-08-28, verbatim: "EQUITY CHANGES ONLY AFTER THE FLOP IS
   * DISPLAYED, (NOT BEFORE OR DURING)".
   *
   * The run-out used to call broadcastCurrentState() and broadcastAllInEquity()
   * back to back, in the same instant. The card had been SENT but had not been
   * SEEN — the client was still mid-animation — so the percentages flipped to
   * the outcome while the card that caused it was still turning over. On the
   * reported hand the villain read 0% and the hero 100% before the river was
   * face up, which tells the player how the hand ends and then shows them the
   * card as a formality.
   *
   * Sized from the board animation itself: the all-in turn and river run the
   * RIVER SQUEEZE (CommunityCards.css, 2026-09-04) with the `all-in` profile -
   * the card materialises face down, holds, and snaps over through its edge.
   * The profile (src/presentation/cardPresentation/profiles.ts) derives its
   * hold FROM this number, so the face is up exactly when this gate opens;
   * the flop's land-and-fan (~1.22s) fits inside it too.
   *
   * This is the REVEAL gate and is separate from allInStreetPauseMs, the beat
   * AFTER the equity settles and before the next card. Both are needed: the
   * first stops the spoiler, the second gives the player time to read it.
   */
  ALL_IN_STREET_REVEAL_MS: 1250,
  /** Beat after the consent panel closes before the first card turns. */
  RIT_REVEAL_LEAD_MS: 600,
  /** One street landing on a RIT board (matches allInStreetPauseMs). */
  RIT_STREET_MS: 1400,
  /** The pause between one board finishing and the next board dealing. */
  RIT_RUN_GAP_MS: 1800,
  /** Last river → winner ribbons + card highlights land together. */
  RIT_RIBBON_MS: 900,
  /**
   * RUN IT 3X recording (2026-08-26): the winner phase is INTERLEAVED per
   * run — run 1's ribbon + highlights land, that run's pot ships, THEN run
   * 2's ribbon, and so on. One of these windows per run covers the ribbon
   * beat, the ship, and a settle before the next run takes the stage
   * (measured ~2.5-3.2s per run in the reference).
   */
  RIT_RESULT_RUN_MS: 2600,
} as const;

export interface HandCompletionOpts {
  /** Did the hand reach a showdown (cards shown), or end on a fold? */
  wentToShowdown: boolean;
  /** How many hands were shown at showdown (2 = heads-up). */
  showdownHands?: number;
  /** Did this hand hit the Bad Beat Jackpot? */
  bbjHit?: boolean;
  /** Run It Twice: how many boards were dealt (0/undefined = single run). */
  ritRuns?: number;
  /** Run It Twice: streets each board re-dealt (1 = river-only, 3 = full). */
  ritStreetsPerRun?: number;
  /**
   * How many award groups the client will animate — one per pot(-half) that
   * pays somebody: main pot, each side pot, and each half of a hi-lo split.
   * The client fires them POT_AWARD_STAGGER_MS apart (TablePage's
   * buildAwardGroups), so a hand paying three groups is animating for
   * 2 x stagger LONGER than a single-winner hand. Default 1.
   */
  potAwardGroups?: number;
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
  // pot travels with its total, the cards are mucked — and then the table
  // RESTS for a full second (Dan 2026-08-27) before the next hand may open.
  // (The button glide is the client's beat at HAND_STARTED — see
  // BUTTON_MOVE_MS above for why it is not added here.)
  //
  // MULTI-POT FIX 2026-08-28. POT_AWARD_STAGGER_MS was defined for this file
  // and then read ONLY by the client: the engine held a flat 4500ms however
  // many winners there were, while the client fires each award group 900ms
  // after the last. Measured from the WINNERS tick, one group's "+N" float
  // ended at T+7400 inside a T+7500 hold (100ms to spare), TWO groups ended
  // at T+8300 and THREE at T+9200 — so on any all-in with a side pot, and on
  // every hi-lo split, the last winner's chip fan and the number telling them
  // what they won were wiped mid-flight by the board clear. Exactly the
  // truncation this file's header was written to eliminate, surviving in the
  // multi-winner case because the arithmetic only ever described one.
  const groups = Math.max(1, Math.floor(opts.potAwardGroups ?? 1));
  const staggerTail = (groups - 1) * H.POT_AWARD_STAGGER_MS;
  const push = H.BETS_SWEEP_MS + H.POT_PUSH_MS + H.MUCK_MS + H.POST_PUSH_PAUSE_MS + staggerTail;

  if (!opts.wentToShowdown) return push;

  const extra = Math.max(0, (opts.showdownHands ?? 2) - 2);
  const read = Math.min(
    H.SHOWDOWN_READ_MAX_MS,
    H.SHOWDOWN_READ_BASE_MS + extra * H.SHOWDOWN_READ_PER_EXTRA_HAND_MS
  );

  /**
   * POKERBROS PARITY 2026-08-26: a run-it-twice hand's boards are revealed by
   * the CLIENT street by street after the engine has already settled, so the
   * hold must additionally cover the whole reveal timeline plus the extra
   * per-board pot ships — otherwise the next hand deals over a board that is
   * still turning its river. Mirrors the client timeline in TablePage's
   * rit_result handler exactly (same constants, same arithmetic).
   */
  if ((opts.ritRuns ?? 0) >= 2) {
    const runs = opts.ritRuns as number;
    const streets = Math.max(1, Math.min(3, opts.ritStreetsPerRun ?? 3));
    const reveal =
      H.RIT_REVEAL_LEAD_MS + runs * streets * H.RIT_STREET_MS + (runs - 1) * H.RIT_RUN_GAP_MS;
    // RUN IT 3X recording (2026-08-26): the winner phase replays run by run
    // (ribbon → ship → settle, one RIT_RESULT_RUN_MS window each), which IS
    // the showdown read for a multi-board hand — `read` is not added on top.
    const resultWindows = runs * H.RIT_RESULT_RUN_MS;
    return reveal + resultWindows + push;
  }

  return read + push;
}

/** The board/card sweep that follows the hold. */
export function boardClearMs(wentToShowdown: boolean): number {
  return wentToShowdown
    ? HAND_COMPLETION.BOARD_CLEAR_SHOWDOWN_MS
    : HAND_COMPLETION.BOARD_CLEAR_FOLD_MS;
}
