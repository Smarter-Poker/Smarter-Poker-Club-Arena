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
 * THE THAW PAYS BACK WHAT THE FREEZE DEFERRED (2026-09-11).
 *
 * Every sweep this flag gates simply SKIPS its work while frozen. Most of them
 * are periodic and come round again on their own; a tournament manager's
 * elimination sweep is not. It is causal - a bust, a registration, a durable
 * wake - and a manager that adopts an event whose tables cannot deal gets
 * exactly one of them, at adoption. Adoption follows an engine restart, and the
 * engine restarts inside this very freeze, so that one sweep always ran frozen,
 * skipped table balancing, and nothing ever asked again.
 *
 * Measured on production 2026-09-11 11:50 UTC: 57 RUNNING events, every live
 * table holding exactly one funded player and no table holding two, frozen
 * since as early as 2026-09-10 06:40 - through every restart in between.
 *
 * A gated caller that must not lose its turn registers here; the listeners run
 * once, synchronously, on the frozen -> thawed edge and are then forgotten.
 */
const thawListeners = new Set<() => void>();

export function setMaintenanceFrozen(value: boolean): void {
  const thawing = frozen && !value;
  frozen = value;
  if (!thawing || thawListeners.size === 0) return;
  const due = [...thawListeners];
  thawListeners.clear();
  for (const listener of due) {
    try {
      listener();
    } catch (err) {
      // One listener never costs another its turn, nor the thaw its tables.
      console.warn('[MaintenanceBreak] a thaw listener threw', err);
    }
  }
}

/** True from the :53 announcement until the :00 resume. */
export function isMaintenanceFrozen(): boolean {
  return frozen;
}

/**
 * Run `listener` once, when the current freeze lifts. Called while the platform
 * is NOT frozen it runs on the next microtask instead - a caller is never left
 * waiting for a freeze that may not come. Returns an unsubscribe.
 */
export function onNextMaintenanceThaw(listener: () => void): () => void {
  if (!frozen) {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) listener();
    });
    return () => {
      cancelled = true;
    };
  }
  thawListeners.add(listener);
  return () => {
    thawListeners.delete(listener);
  };
}
