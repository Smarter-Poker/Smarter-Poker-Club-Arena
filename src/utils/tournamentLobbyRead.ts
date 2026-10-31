export interface TournamentLobbyChange<T> {
  revision: number;
  row: T | null;
  insertOnly?: boolean;
}

/** Preserve changes committed to this browser after the read began. A busy
 * lobby can paint immediately; it never needs a quiet interval or another read.
 */
export function reconcileTournamentLobbyRead<T extends { id: string }>(
  snapshot: readonly T[],
  changes: ReadonlyMap<string, TournamentLobbyChange<T>>,
  revisionAtRead: number
): T[] {
  const rows = new Map(snapshot.map((row) => [row.id, row]));
  for (const [id, change] of changes) {
    if (change.revision <= revisionAtRead) continue;
    if (change.row === null) rows.delete(id);
    else if (change.insertOnly ? !rows.has(id) : rows.has(id)) {
      rows.set(id, { ...rows.get(id), ...change.row });
    }
  }
  return [...rows.values()];
}
