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
 */
export const PRE_ACTION_EXEC_GRACE_MS = 2500;

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
