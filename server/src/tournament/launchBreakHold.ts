/**
 * A LAUNCH THAT CANNOT FINISH SEATING BEFORE :53 WAITS FOR THE THAW (2026-10-03).
 *
 * Every launch seat goes through the atomic seat door, which answers
 * platform_frozen from the :53 announcement (fn_entry_purchases_frozen). A
 * launch begun too close to :53 is cut in half: production 2026-10-03, MTT
 * 4735c72d began seating at 04:50:59, certified 194 seats at ~0.63 s apiece,
 * was refused at 04:53:01 and released its manager, and was restarted from the
 * half-seated board at 05:00:35. So the start gate estimates the seating time
 * from the field it is about to seat and, when that would cross the next :53,
 * holds the start; the first discovery pass after the thaw starts it, exactly
 * as it already starts an event whose clock falls inside the break.
 * Deliberately generous (0.75 s a seat plus a 20 s base): starting a few
 * minutes later is cheap, a half-made launch is not.
 */
export const LAUNCH_SEATING_BASE_MS = 20_000;
export const LAUNCH_SEATING_PER_PLAYER_MS = 750;
export function launchSeatingBudgetMs(fieldCount: number): number {
  const field = Number.isFinite(fieldCount) && fieldCount > 0 ? Math.ceil(fieldCount) : 0;
  return LAUNCH_SEATING_BASE_MS + field * LAUNCH_SEATING_PER_PLAYER_MS;
}
/** Hold the start when the estimated seating would run into the :53 announcement. */
export function launchWouldCrossLastHand(fieldCount: number, msUntilLastHand: number): boolean {
  return Number.isFinite(msUntilLastHand) && msUntilLastHand < launchSeatingBudgetMs(fieldCount);
}

/**
 * A BREAK-ADJACENT LAUNCH GETS A WINDOW A DISCOVERY PASS CAN HIT (2026-10-20).
 *
 * The start gate admits a scheduled field from `scheduledLaunchPreparationAt`
 * and holds it once `launchWouldCrossLastHand` says the seating would run into
 * the :53 door. For a start the break moves ahead of the door, those two
 * instants used to be one seated minute apart, so a discovery pass that came
 * round more than sixty seconds after preparation opened found the start
 * held, and the event was launched only after the thaw. Production
 * 2026-10-19: both 342-player 17:00 freerolls opened at 16:47:27, the pass
 * reached them at 16:48:37, and they were held to the thaw and dealt 196 and
 * 202 s late. Starts at :53-:54 were worse: they were measured against the
 * PREVIOUS hour's break, so their window was under a minute or none at all.
 *
 * So every start whose seating would come within this margin of the next
 * (or previous) last-hand door, or of the thaw, is prepared this much
 * earlier, and the window
 * between preparation and the hold is the seated minute plus the margin. It
 * moves SEATING only: start() still holds dealing and the level clock to the
 * advertised `start_time`, and the hold itself is unchanged.
 */
export const LAUNCH_BREAK_PASS_MARGIN_MS = 3 * 60_000;

/** Latest setup admission that leaves the promised seated minute intact. */
export function scheduledLaunchPreparationAt(
  startAt: number,
  fieldCount: number,
  seatedLeadMs: number,
  maintenance: { startMinute: number; lastHandLeadMs: number; durationMs: number }
): number {
  const hourMs = 60 * 60_000;
  const budget = launchSeatingBudgetMs(fieldCount);
  let readyAt = startAt - seatedLeadMs;
  // The freeze in this start's clock hour (which may come after the start)
  // and the one before it; the later one first, so a field moved ahead of it
  // is then checked against the earlier break too.
  const hourFreezeAt = Math.floor(startAt / hourMs) * hourMs + maintenance.startMinute * 60_000;
  for (const freezeStartsAt of [hourFreezeAt, hourFreezeAt - hourMs]) {
    const lastHandAt = freezeStartsAt - maintenance.lastHandLeadMs;
    const freezeEndsAt = freezeStartsAt + maintenance.durationMs;
    // Entry doors close at last-hand, not at countdown. Keep the seated
    // minute and the pass margin ahead of that door, so a discovery pass
    // that is slow to come round cannot turn the budget boundary into a
    // start held to the thaw or a refused half-launch.
    const latestReadyAt = lastHandAt - seatedLeadMs - LAUNCH_BREAK_PASS_MARGIN_MS;
    // The same margin after the thaw: the first passes after :00 share the
    // engine with the whole fleet's resume, so a setup due that close to the
    // thaw is moved ahead of the break as well.
    if (readyAt > latestReadyAt && readyAt - budget < freezeEndsAt + LAUNCH_BREAK_PASS_MARGIN_MS) {
      readyAt = latestReadyAt;
    }
  }
  return readyAt - budget;
}
