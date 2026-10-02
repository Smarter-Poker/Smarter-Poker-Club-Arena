/**
 * THE PROCESS-WIDE FREEZE FLAG (Dan, 2026-09-01).
 *
 * "THE ENTIRE PLATFORM NEEDS TO FREEZE FOR THE 5 MINUTES ... HORSES SHOULD
 * NOT STAND UP OR ROTATE, EVERYTHING JUST FREEZES."
 *
 * One module-level boolean, set only by MaintenanceBreak, read by every
 * periodic sweep that moves money or seats. It exists because those sweeps
 * live in a dozen services that have no reference to the GameServer instance,
 * and threading a supplier through every constructor would touch far more
 * code than the guarantee needs.
 *
 * The flag is the ENGINE'S half of the freeze. The other half lives in
 * Postgres (fn_platform_frozen + the zz_freeze_guard triggers), because the
 * engine is dead for ~2 of the 5 minutes and pg_cron and browsers do not stop
 * when it does. The two halves are armed by the same row in
 * engine_maintenance_break, so they cannot disagree about whether a freeze is
 * running.
 *
 * Set from the ANNOUNCEMENT (:53), not the countdown (:55), deliberately: a
 * horse standing up at :54 while the felt says "Last Hand" is the same tell
 * as one standing up at :56, and no sweep this gates does anything that
 * cannot wait seven minutes.
 */

let frozen = false;

/**
 * A DECIDED EVENT IS PAID BEFORE THE BREAK, NOT AFTER IT (2026-10-02).
 *
 * The flag above goes up at the :53 announcement, and `finishTournament`
 * refused on it, so the platform stopped paying winners two minutes before
 * the break it was waiting for. Read on production on 2026-10-02: the last
 * terminal settlement before each break landed at 14:52:54, 15:52:57 and
 * 16:52:58 and the next at 15:03:09, 16:03:00 and 17:02:48 (one at the thaw
 * itself); 16-25 completions a minute either side, none in between. Every
 * event whose field was decided from :52 on waited out the whole break with
 * its winner unpaid, and `fn_ca_tournament_finished_but_not_completed(15)`
 * filed a critical incident for the ones the queue had already held.
 *
 * The finish moves no table action: the field is one player, no hand is in
 * the air and nothing is dealt. The money it moves is the settlement of the
 * hand that decided the event, and the last hand on every other table is
 * still being settled at :54 by design. The database's own freeze
 * (fn_platform_frozen) does not arm for the last-hand phase until
 * announced_at + 2 minutes, i.e. :55. So between the announcement and the
 * break, a terminal settlement is admitted until TERMINAL_SETTLEMENT_LEAD_MS
 * before the break begins, which is longer than the 45-second statement
 * ceiling of fn_complete_tournament_terminal: a finish admitted in the window
 * has its answer before the five minutes start, and nothing new is admitted
 * after it. Everything else the flag gates (seats, horses, registrations,
 * launches, rebuys, deals, sweeps) still stops at :53, exactly as before.
 *
 * The window exists only when the break was ANNOUNCED with a known start.
 * Every other way into the freeze (an adopted break, a countdown, a recovery
 * hold, a release boundary) passes no start and is closed for settlement
 * from its first instant; so is a countdown begun early.
 */
export const TERMINAL_SETTLEMENT_LEAD_MS = 60_000;
let terminalSettlementClosesAt: number | null = null;

/**
 * THAW SUBSCRIBERS (2026-09-21).
 *
 * The flag above answers "may I move money right now?". It could not answer
 * "the freeze is over, do the thing you were not allowed to do", and every
 * periodic sweep that reads it does the same thing on a frozen tick: `return`.
 *
 * For a sweep on a short cadence that is correct - the next tick is seconds
 * away. For a sweep on a LONG cadence it silently doubles the period, because
 * the dropped tick is never made up. Measured 2026-09-21 on the rakeback
 * settler: a 30-minute interval landing at :26 and :56, with the freeze
 * running :53 to :00, executed ONLY the :26 tick. Every :56 tick was
 * discarded, the settler ran hourly instead of half-hourly, and its watermark
 * sat up to 52 minutes stale behind 985 unaccrued rake_records - which is
 * exactly what `weekly_rake_source_not_fully_accrued` refuses to settle on.
 *
 * So the freeze now says when it ENDS. Listeners are fired once, on the
 * true->false edge only, synchronously, and a throwing listener cannot stop
 * the others or the thaw itself. This is an EVENT, not a timer: nothing here
 * polls, retries or repairs, and a listener that is never registered costs
 * nothing.
 */
type MaintenanceThawListener = () => void;
const thawListeners = new Set<MaintenanceThawListener>();

export function setMaintenanceFrozen(value: boolean, lastHandEndsAt?: number): void {
  const wasFrozen = frozen;
  frozen = value;
  terminalSettlementClosesAt =
    value && typeof lastHandEndsAt === 'number' && Number.isFinite(lastHandEndsAt)
      ? lastHandEndsAt - TERMINAL_SETTLEMENT_LEAD_MS
      : null;
  if (!wasFrozen || value) return;
  // Snapshot: a listener may unsubscribe itself from inside its own callback.
  for (const listener of [...thawListeners]) {
    try {
      listener();
    } catch (e) {
      // An observer that throws must not hold the platform frozen for anyone
      // else. Report and carry on to the next listener.
      console.error('[freezeState] a maintenance-thaw listener threw', e);
    }
  }
}

/**
 * Register a callback for the moment the freeze lifts. Returns the
 * unsubscribe, which the caller MUST invoke on stop - a listener holding a
 * stopped generation would otherwise re-arm work the lifecycle has fenced.
 */
export function onMaintenanceThaw(listener: MaintenanceThawListener): () => void {
  thawListeners.add(listener);
  return () => {
    thawListeners.delete(listener);
  };
}

/** True from the :53 announcement until the :00 resume. */
export function isMaintenanceFrozen(): boolean {
  return frozen;
}

/**
 * May a decided tournament's terminal settlement start now? False outside a
 * freeze; during one, true only before the announced last-hand window's
 * settlement cutoff (see TERMINAL_SETTLEMENT_LEAD_MS). Only the finish of an
 * event that is already down to its last player reads this; every other gate
 * keeps reading isMaintenanceFrozen().
 */
export function isTerminalSettlementFrozen(now: number = Date.now()): boolean {
  if (!frozen) return false;
  return terminalSettlementClosesAt === null || now >= terminalSettlementClosesAt;
}
