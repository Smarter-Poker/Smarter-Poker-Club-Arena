// How the owner-dispatched retention drain shares the adaptive capacity lock.
//
// fn_prune_horse_adaptive_journal() holds the advisory lock
// 'horse-adaptive-work-capacity-v1' for its whole call. The engine's journal
// enqueue (fn_queue_horse_adaptive_batch) and append
// (fn_append_horse_adaptive_observations) only TRY that lock and give up at
// once when it is held. The engine's own lane never collides with itself: it
// runs work, then retention, one after the other in a single loop. A drain
// calling the owner back to back from outside held the lock almost
// continuously, so on 2026-10-15 no new horse observation was recorded for as
// long as a drain ran (05:40 to 11:20 and from 11:50 UTC; one batch failed 91
// times). Hands retired meanwhile then had their observations refused as
// retention_compacted.
//
// So the drain yields: it never starts a call while journal work is ready for
// the engine, and after every call it stays off the lock for at least as long
// as the call held it. That leaves the engine at least half of the time, and
// all of it whenever the engine has something waiting.

export const DRAIN_MIN_PAUSE_MS = 1000;
export const DRAIN_MAX_PAUSE_MS = 10000;
export const DRAIN_READY_WORK_WAIT_MS = 2000;

/** Time to stay off the capacity lock after a call that held it callMs. */
export function pauseAfterCallMs(callMs) {
  const held = Number.isFinite(callMs) && callMs > 0 ? Math.ceil(callMs) : 0;
  return Math.min(DRAIN_MAX_PAUSE_MS, Math.max(DRAIN_MIN_PAUSE_MS, held));
}

/** Read-only: is any adaptive journal work due for the engine now or within
 * the next couple of seconds? The drain waits rather than take the lock. */
export const READY_WORK_SQL = `SELECT EXISTS(
  SELECT 1 FROM public.horse_adaptive_journal_work
  WHERE (state = 'queued' AND (available_at IS NULL OR available_at <= now() + interval '2 seconds'))
     OR (state = 'leased' AND lease_until > now())
) AS ready`;
