/**
 * =========================================================================
 *  THE FIVE MINUTE RULE THAT ONLY EXISTED IN A COMMENT
 * =========================================================================
 *
 * `GameServer.ts` has carried this line above its stuck-COMPLETING scan since
 * the scan was written:
 *
 *     // If a tournament has been in COMPLETING status for > 5 minutes,
 *     // force it to COMPLETED.
 *
 * The query underneath it is `.eq('status', 'COMPLETING')` and nothing else.
 * There is no age test, and there cannot be one from the row alone:
 * `tournaments.updated_at` is not maintained by the writers on this path
 * (checked live 2026-09-01 - a tournament that was RUNNING and changing every
 * few seconds carried an `updated_at` three days old), so "how long has this
 * been COMPLETING" is not a question the database can answer.
 *
 * WHY THE RULE MATTERS. The scan skips a tournament this instance is still
 * managing, but a manager is removed from `tournamentEngines` the moment it
 * stops - and `finishTournament` flips the row to COMPLETING BEFORE it pays.
 * So there is a window in which the finish is mid-payout and the row looks
 * abandoned. `recoverStuckCompletingTournaments` is idempotent and shares its
 * ledger keys with the finish path, which is what has kept that race from
 * costing money; it is not a reason to keep running the race. A recovery that
 * waits five minutes cannot collide with a finish that takes seconds.
 *
 * The dwell is measured HERE, in the engine that is watching, rather than
 * asked of a column nobody updates: a row is due only once it has been seen
 * continuously in COMPLETING for the whole window. A row that leaves the state
 * is forgotten, so a tournament that legitimately completes and a later one
 * that gets stuck never share a clock.
 *
 * Pure, so the rules are pinned without a database or a fake timer.
 */

/** Dan's rule, and the one the comment always claimed was implemented. */
export const COMPLETING_DWELL_MS = 5 * 60 * 1000;

export interface CompletingDwellResult {
  /** Rows watched long enough that recovery may act on them. */
  due: string[];
  /**
   * The map to carry into the next pass: every id currently COMPLETING, with
   * the timestamp it was FIRST seen, and nothing else. Ids that left the state
   * are dropped, so the map is bounded by the live COMPLETING set rather than
   * by everything the process has ever seen.
   */
  seenAt: Map<string, number>;
}

export function selectCompletingDue(
  completingIds: readonly string[],
  previousSeenAt: ReadonlyMap<string, number>,
  now: number,
  dwellMs: number = COMPLETING_DWELL_MS
): CompletingDwellResult {
  const seenAt = new Map<string, number>();
  const due: string[] = [];

  for (const raw of completingIds ?? []) {
    const id = String(raw ?? '');
    if (!id) continue;
    if (seenAt.has(id)) continue; // the same row twice in one read is one row

    const firstSeen = previousSeenAt.get(id) ?? now;
    seenAt.set(id, firstSeen);
    if (now - firstSeen >= dwellMs) due.push(id);
  }

  return { due, seenAt };
}
