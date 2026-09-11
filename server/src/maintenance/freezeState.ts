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
const thawListeners = new Set<() => void>();

export function setMaintenanceFrozen(value: boolean): void {
  const thawing = frozen && !value;
  frozen = value;
  if (!thawing) return;
  const due = [...thawListeners];
  thawListeners.clear();
  for (const listener of due) listener();
}

/** True from the :53 announcement until the :00 resume. */
export function isMaintenanceFrozen(): boolean {
  return frozen;
}

/**
 * Subscribe once to the actual thaw edge. This also works for an on-demand
 * freeze or an overrun: a wall-clock boundary never substitutes for authority.
 * Lifecycle abort removes the subscription immediately. An already-thawed
 * caller is delivered on a cancellable microtask, without awaiting a new freeze.
 */
export function onNextMaintenanceThaw(listener: () => void, signal?: AbortSignal): () => void {
  let active = !signal?.aborted;
  const cancel = () => {
    active = false;
    thawListeners.delete(deliver);
    signal?.removeEventListener('abort', cancel);
  };
  const deliver = () => {
    if (!active) return;
    cancel();
    try {
      listener();
    } catch (error) {
      console.warn('[MaintenanceBreak] a thaw listener failed', error);
    }
  };
  if (!active) return cancel;
  signal?.addEventListener('abort', cancel, { once: true });
  if (frozen) thawListeners.add(deliver);
  else queueMicrotask(deliver);
  return cancel;
}
