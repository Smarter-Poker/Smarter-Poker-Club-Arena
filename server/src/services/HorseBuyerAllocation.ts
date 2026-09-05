/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BUYER IS COUNTED ONCE (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ClusterController opens a feeder for a must-move game when Main 1 is
 * full and at least two "buyers" are waiting (OPORD 1.4 18.3). A horse is a
 * buyer (CLAUDE.md 10.5), and the fleet supplies the count. Until today that
 * count was `pool.length`: the number of horses that COULD sit at that table.
 *
 * The same free horse is in the pool of every full Main 1 on the host, so two
 * spare horses made the controller open a feeder in every full game at once.
 * The two horses filled one feeder; the rest sat empty for three minutes,
 * were abandoned, and were re-opened two minutes later. Measured on
 * 2026-09-05 03:05 CDT: 12 feeders opened in an hour, 2 went live, 11 were
 * abandoned - every 5.5 minutes, all night.
 *
 * The number the controller needs is how many horses the fleet would actually
 * seat at THIS table next cycle given the whole floor: an allocation, not a
 * pool size. This module is that allocation, as a pure function so it can be
 * proven without a database.
 *
 * The walk is in the fleet's own seeding order (opening feeders first, then a
 * game's mains, then its feeders), which is the order the seats were actually
 * handed out this cycle, so the answer is consistent with what happened.
 */

export interface BuyerPool {
  tableId: string;
  /** Null for a table outside any must-move game. */
  clusterId: string | null;
  /** Horse ids that passed every candidate gate for this table, in the
   *  order the fleet would take them. */
  pool: readonly string[];
  /** How many of them this table would take: its open seats, or the probe
   *  size for a full table (FULL_TABLE_BUYER_PROBE). */
  seatsWanted: number;
}

/**
 * A FULL table only needs the controller to know whether TWO buyers exist
 * (18.3 opens a feeder at two). Letting it reserve more would eat the shared
 * capacity that the tables with real open seats need.
 */
export const FULL_TABLE_BUYER_PROBE = 2;

/**
 * Allocate the floor's spare horse capacity across `tables`, in order.
 *
 * `capacityByHorse` is how many MORE tables each horse may open this cycle
 * (its tag ceiling minus the tables it already sits at). A horse absent from
 * the map has no capacity. A horse is never taken twice for the same cluster
 * within the pass, and never taken once its capacity reaches zero.
 *
 * Returns tableId -> the number of horses allocated to it.
 */
export function allocateBuyers(
  tables: readonly BuyerPool[],
  capacityByHorse: ReadonlyMap<string, number>
): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const [h, c] of capacityByHorse) remaining.set(h, Math.max(0, Math.floor(c)));
  /* `${clusterId}|${horseId}` already placed in this pass. ONE SEAT PER GAME:
     the candidate filter already keeps a horse seated in a game out of that
     game's other pools, but within one pass the allocator itself must not hand
     the same horse to two tables of one game. */
  const placedInCluster = new Set<string>();
  const out = new Map<string, number>();

  for (const t of tables) {
    let taken = 0;
    const want = Math.max(0, Math.floor(t.seatsWanted));
    if (want > 0) {
      const seen = new Set<string>();
      for (const h of t.pool) {
        if (taken >= want) break;
        if (seen.has(h)) continue;
        seen.add(h);
        const cap = remaining.get(h) ?? 0;
        if (cap <= 0) continue;
        const clusterKey = t.clusterId ? `${t.clusterId}|${h}` : null;
        if (clusterKey && placedInCluster.has(clusterKey)) continue;
        remaining.set(h, cap - 1);
        if (clusterKey) placedInCluster.add(clusterKey);
        taken++;
      }
    }
    out.set(t.tableId, taken);
  }
  return out;
}
