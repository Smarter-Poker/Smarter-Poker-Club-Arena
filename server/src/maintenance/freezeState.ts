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
 * THE LAST-HAND SETTLEMENT WINDOW (2026-10-03).
 *
 * The engine flag above goes up at the :53 announcement, but the database
 * freeze (fn_platform_frozen) only arms at :55, and :53-:55 is exactly the
 * window in which every table is told to FINISH the hand in front of it. A
 * tournament whose last hand ends in that window is decided, and paying it is
 * the same "finish what is in front of you" the tables are doing. Holding the
 * payout behind the engine flag made every event decided after :53 wait for
 * the thaw (up to ~8 minutes) with its winner unpaid.
 *
 * So the announcement opens a bounded window for TERMINAL settlement only,
 * closing a reserve before :55 so a settlement is never in flight at the
 * cutover. Nothing else reads it: every sweep, entry, seat move and rebuy
 * still answers to isMaintenanceFrozen(). Any other freeze (countdown,
 * adoption, recovery hold, release boundary) closes it, and the thaw clears it.
 */
let terminalSettlementOpenUntilMs = 0;

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

export function setMaintenanceFrozen(value: boolean): void {
  const wasFrozen = frozen;
  frozen = value;
  // Every freeze edge closes the last-hand settlement window; only the
  // announcement reopens it, after this call (setLastHandSettlementWindow).
  terminalSettlementOpenUntilMs = 0;
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
 * Open (untilMs > now) or close (0) the last-hand terminal settlement window.
 * Only MaintenanceBreak.announceBreak opens it, and only while frozen.
 */
export function setLastHandSettlementWindow(untilMs: number): void {
  terminalSettlementOpenUntilMs = frozen && Number.isFinite(untilMs) && untilMs > 0 ? untilMs : 0;
}

/**
 * May an already-DECIDED tournament commit its terminal settlement now?
 * Frozen except inside the last-hand window opened by the announcement.
 */
export function isTerminalSettlementFrozen(now: number = Date.now()): boolean {
  if (!frozen) return false;
  return !(terminalSettlementOpenUntilMs > 0 && now < terminalSettlementOpenUntilMs);
}
