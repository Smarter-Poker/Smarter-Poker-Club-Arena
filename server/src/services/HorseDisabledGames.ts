/**
 * THE OPERATOR'S SWITCH, AS THE FLEET READS IT (2026-09-05).
 *
 * `cash_games.enabled = false` is OPORD 1.4 18.4: "no seeding, no opening;
 * empties close". The controller does the closing (`fn_cash_cluster_tick`
 * closes a disabled game's empty tables); the fleet has to do the not-seeding,
 * and until today it did not know the switch existed. The seeding loop skipped
 * a cluster table only when its LIFECYCLE was 'breaking' or 'closed', so a
 * disabled game whose tables were still 'live' or 'opening' was seeded like any
 * other - and a table the fleet keeps seating is never empty, so the
 * controller's "empties close" never gets its turn. The two halves of 18.4
 * were fighting each other.
 *
 * Pure, so the rule can be tested without a database: a set of disabled game
 * ids read once per cycle, and one predicate the seeding loop and the
 * seat-call path both ask. Two callers, one rule; a second copy of the
 * predicate is the bug shape this repo keeps paying for.
 */

/** The shape `select id from cash_games where enabled = false` returns. */
export interface DisabledGameRow {
  id: string;
}

/** The minimum a table row must carry to be asked. */
export interface ClusterTableLike {
  cluster_id?: string | null;
}

/** Build the per-cycle set. Ids are compared as strings, as PostgREST hands them over. */
export function buildDisabledGameIds(rows: ReadonlyArray<DisabledGameRow>): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r && r.id != null && String(r.id) !== '') out.add(String(r.id));
  }
  return out;
}

/**
 * True when this table belongs to a game the operator has switched off.
 *
 * A table with no `cluster_id` is not part of any cash game and therefore
 * can never be "of a disabled game" - the legacy floor is governed by its own
 * switches, not this one. An empty set (the read failed, or nothing is
 * disabled) disables nothing: the loader fails OPEN on purpose, because
 * treating an unread set as "everything is disabled" would empty every
 * cluster game on one bad read.
 */
export function isTableOfDisabledGame(
  table: ClusterTableLike,
  disabledGameIds: ReadonlySet<string>
): boolean {
  if (!table.cluster_id) return false;
  if (disabledGameIds.size === 0) return false;
  return disabledGameIds.has(String(table.cluster_id));
}
