/**
 * ═══ AN ARMED PRE-ACTION MUST NOT FLASH THE ACTION PANEL (Dan 2026-08-29) ═══
 *
 * Dan, verbatim: "WHEN YOU ARE PLAYING IN THE LIVE PAGES, AND YOU CLICK A
 * 'PRE SELECT OPTION' IT SHOULD JUST EXECUTE THAT OPTION ... IT CURRENTLY
 * 'EXECUTES THE CHOICE' BUT THEN IT 'FLASHES THE ACTION TAB BACK UP' BEFORE
 * IT CLOSES IT AGAIN. THAT SHOULDN'T HAPPEN."
 *
 * Pre-actions are executed by the ENGINE (Bible V8 §4.15). Between the
 * snapshot that hands the hero the turn and the snapshot carrying the
 * engine's auto-executed action there is one network round trip, and the
 * ActionPanel was mounting for exactly that gap — flashing up and closing.
 *
 * This module is the pure half of the fix: the rule for whether the armed
 * pre-action is one the engine can honor RIGHT NOW (so the panel may stay
 * down), and the grace window after which the panel must appear anyway.
 * TablePage owns the timer and the render gate; keeping the rule pure is
 * what lets a unit test pin it without a table.
 */

export type ArmedPreAction = 'fold' | 'check' | 'call' | 'callAny' | null;

/**
 * How long the panel may stay suppressed while waiting for the engine to
 * execute an armed pre-action. If nothing has happened by then — engine
 * down, clear lost, a refusal the client could not predict — the panel
 * appears and the player acts manually. Suppression can only ever cost the
 * flash gap; it must never cost the player their turn.
 *
 * ── THE TIMING CONTRACT WITH THE ENGINE (2026-08-29 hardening) ─────────────
 *
 * This number is NOT free. The engine deliberately holds a pre-action for a
 * visible beat before landing it (`preActionVisibleMs` in
 * server/src/engine/ServerTableEngineTurns.ts — Dan 2026-08-20: "a
 * pre-action is still an ACTION and must be seen", so a street of armed
 * seats does not resolve in one tick). The grace here must therefore cover
 * that whole beat PLUS a realistic broadcast round trip, or the panel would
 * flash up mid-beat on every pre-action — the exact bug this module fixes.
 * The relationship is pinned by tests/unit/preActionPanelGate.test.ts, which
 * reads BOTH files: raise the engine's beat and that test forces this grace
 * up with it, in the same commit.
 *
 * Why the engine does not simply TELL the hero's client "I will act": the
 * only live channel is the table-wide broadcast, and announcing an armed
 * pre-action there before it lands would hand every villain a tell the
 * visible beat exists to mask. The client instead mirrors the engine's own
 * honorability rule (same inputs, snapshotted at the same arm moment), so
 * the deterministic refusal cases — a bet under an armed Check, a raise past
 * an armed Call's price — never suppress at all, and this grace only ever
 * covers the engine's beat plus the wire.
 */
export const PRE_ACTION_EXEC_GRACE_MS = 2500;

/**
 * HOW LONG "NOBODY IS ON THE CLOCK" IS ALLOWED TO MEAN "THE NEXT ACTOR IS
 * STILL BEING DECIDED" (Dan 2026-09-07, item 5).
 *
 * `currentPlayerSeat` is blanked to 0 the moment any player acts and is only
 * set again when the engine names the next actor, so every action at the table
 * produces `seat N -> 0 -> seat M`. The pre-action bar used to require
 * `> 0` and therefore unmounted in that gap, remounting a moment later and
 * replaying its 300ms entrance for a change that had not happened - the
 * "constantly disappears and reappears" Dan filmed.
 *
 * There is no event for "the next actor is being decided", so this is the one
 * place a duration is the honest answer. It is deliberately SHORT: long enough
 * to cover the engine beat plus a slow phone's round trip, short enough that
 * any other silence - an all-in runout, a stalled engine - stops claiming a
 * turn is coming within about a second rather than for the rest of the hand.
 *
 * The end of a hand does NOT rely on this: HAND_COMPLETE is an event, and
 * TablePage's `handSettling` flag reads it directly. A timer is the fallback
 * for the silence that has no event, never a substitute for one that does.
 */
export const PRE_ACTION_GAP_BRIDGE_MS = 1200;

/**
 * The margin the grace must keep over the engine's visible beat, covering a
 * slow broadcast round trip on a phone. Pinned with the contract test.
 */
export const PRE_ACTION_GRACE_RTT_MARGIN_MS = 1000;

/**
 * Can the engine honor this armed pre-action at the current price?
 *
 *  - fold (auto_fold / auto_check_fold) and Call Any: always;
 *  - Check: only when there is nothing to call;
 *  - Call <N>: only while the price still fits the cap armed at press time
 *    (the engine refuses an auto_call past its armed price — this is the
 *    client half of the same rule, Dan 2026-08-28).
 *
 * @param preAction the armed pre-action, null when none is armed
 * @param callDue   chips the hero would need to add to call right now
 * @param armedCallCap the price snapshotted when 'call' was armed
 */
export function isPreActionHonorable(
  preAction: ArmedPreAction,
  callDue: number,
  armedCallCap: number
): boolean {
  if (preAction === 'fold' || preAction === 'callAny') return true;
  if (preAction === 'check') return callDue === 0;
  if (preAction === 'call') return callDue <= armedCallCap;
  return false;
}
