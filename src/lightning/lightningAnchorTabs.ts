/**
 * LIGHTNING: THE ANCHOR SEAT IS NOT A SECOND TABLE (2026-10-24).
 *
 * A Lightning player's chips stay on an anchor seat at a real table, so its
 * table_seats row stays open while they play in the room tab keyed by their
 * pool-session id. MultiTablePage rebuilds its tabs from open seat rows; it
 * saw the anchor, did not know the room tab is that seat, and added the anchor
 * as another tab. That tab's handoff followed to the room, found it open,
 * closed itself and asked for the rebuild again, which added it again.
 *
 * When a game's room is already open in a tab, its anchor seat is already
 * shown. With no room tab open the anchor is kept: its handoff is how the
 * player gets back into the room.
 */

export interface SeatRebuildRow {
  id: string;
  cluster_id?: unknown;
}

/**
 * The open-seat table ids the rebuild should NOT add as tabs, because the
 * Lightning room for that table's game is already open. `roomCluster` answers
 * which Cluster an open tab's room belongs to (null for an ordinary table).
 */
export function anchorsShownByOpenRooms(
  rows: readonly SeatRebuildRow[],
  openTabIds: readonly string[],
  roomCluster: (tabId: string) => string | null | undefined
): Set<string> {
  const openClusters = new Set<string>();
  for (const id of openTabIds) {
    const cluster = roomCluster(id);
    if (cluster) openClusters.add(cluster);
  }
  const skip = new Set<string>();
  if (openClusters.size === 0) return skip;
  for (const row of rows) {
    if (typeof row.cluster_id === 'string' && openClusters.has(row.cluster_id)) skip.add(row.id);
  }
  return skip;
}
