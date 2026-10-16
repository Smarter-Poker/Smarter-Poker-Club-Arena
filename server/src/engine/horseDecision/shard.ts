/**
 * Which decision-worker shard owns a fence (2026-09-26, moved here 2026-10-16).
 *
 * The lane routes every job for one table to one worker by this hash, and
 * since 2026-10-16 the worker uses the same function to tell a completed hand
 * of its own tables (journaled and learned as before) from a hand another
 * shard owns, which it only learns from (see mindMirror.ts). Kept in its own
 * module so the worker thread can import it without the main-thread client.
 */

/** FNV-1a over the fence's table id. Stable across processes and restarts. */
export function horseDecisionShard(fence: string, workers: number): number {
  if (!Number.isSafeInteger(workers) || workers <= 1) return 0;
  const colon = fence.indexOf(':');
  const key = colon > 0 ? fence.slice(0, colon) : fence;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % workers;
}
