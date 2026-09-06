/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BUYER IS COUNTED ONCE (2026-09-05), AND A FEEDER KEEPS THE ONES IT WAS
 * OPENED FOR (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ClusterController opens a feeder for a must-move game when Main 1 is
 * full and at least two "buyers" are waiting (OPORD 1.4 18.3). A horse is a
 * buyer (CLAUDE.md 10.5), and the fleet supplies the count. Until 2026-09-05
 * that count was `pool.length`: the number of horses that COULD sit at that
 * table.
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
 * ── THE RESERVATION (2026-09-06) ──────────────────────────────────────────
 *
 * A table opened on the strength of N buyers must have first claim on those N
 * buyers until it is live or abandoned. That is the same courtesy OPORD 18.3
 * already gives a human: a single buyer gets a 60-second `table_opening_hold`
 * rather than a ghost table. It is not a horse mechanism and gives a horse no
 * different deal (CLAUDE.md 10.5) - it is a rule about a TABLE, and a human
 * on the waitlist of an opening feeder is claimed by the same walk.
 *
 * Until today an opening feeder was served first only as a SIDE EFFECT of the
 * fleet's sort order (`lifecycle === 'opening'` ranks -1), which the caller
 * could reorder without noticing and which said nothing about how much the
 * feeder was allowed to claim. The claim is explicit now:
 *
 *   - `reserved`  an opening feeder. Walked FIRST, whatever order the caller
 *                 hands the tables in, and capped at the two seats 18.3 needs
 *                 to flip it live - never the whole table, so a feeder cannot
 *                 strand the floor.
 *   - `seating`   a table with real open seats, walked in the caller's order.
 *   - `probe`     a FULL cluster table, asking only whether two buyers exist.
 *
 * A probe still consumes, and must: the whole point of the 2026-09-05 fix is
 * that two spare horses are two buyers ONCE, not two buyers in every full
 * game on the floor. What it may no longer do is book a SECOND set of horses
 * for a game whose feeder is already holding a reservation - the tick refuses
 * to open while one is `opening` (`v_open_unreserved` counts its seats), so
 * those horses were reserved for a decision that cannot be taken, and were
 * taken away from other games' feeders. A game with a reservation reports the
 * reservation.
 *
 * NOTHING IS STORED. The claim is derived from the live table list every
 * cycle, so it cannot outlive the feeder: the moment the row stops being
 * `opening` - live or abandoned - the caller stops passing `reserved`, and a
 * cycle that dies half way through leaves no state to leak.
 */

export type BuyerClaim = 'reserved' | 'seating' | 'probe';

export interface BuyerPool {
  tableId: string;
  /** Null for a table outside any must-move game. */
  clusterId: string | null;
  /** Horse ids that passed every candidate gate for this table, in the
   *  order the fleet would take them. */
  pool: readonly string[];
  /** How many of them this table would take: its open seats, the probe size
   *  for a full table (FULL_TABLE_BUYER_PROBE), or the reservation an opening
   *  feeder holds (FEEDER_BUYERS_TO_GO_LIVE minus whoever already sat). */
  seatsWanted: number;
  /** What kind of claim this is. See the header. */
  claim: BuyerClaim;
}

/**
 * A FULL table only needs the controller to know whether TWO buyers exist
 * (18.3 opens a feeder at two). Letting it reserve more would eat the shared
 * capacity that the tables with real open seats need.
 */
export const FULL_TABLE_BUYER_PROBE = 2;

/**
 * What an opening feeder claims: the two seated players 18.3 promotes it at
 * (`lifecycle = 'opening' AND seated >= 2` in `fn_cash_cluster_tick`), less
 * whoever is already on it. The same number for the same reason as the probe
 * above, and deliberately not more: the feeder needs two to become a table,
 * and the rest of the floor needs the others.
 */
export const FEEDER_BUYERS_TO_GO_LIVE = 2;

/**
 * Allocate the floor's spare horse capacity across `tables`.
 *
 * `capacityByHorse` is how many MORE tables each horse may open this cycle
 * (its own ceiling and the platform's four-game limit, whichever is tighter -
 * see HorseGameLoad). A horse absent from the map has no capacity. A horse is
 * never taken twice for the same cluster within the pass, and never taken
 * once its capacity reaches zero.
 *
 * Reserved tables are walked first, then everything else in the order given.
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
  /* Every table asked about gets an answer, including one no phase reaches. */
  for (const t of tables) out.set(t.tableId, 0);

  const take = (t: BuyerPool): number => {
    let taken = 0;
    const want = Math.max(0, Math.floor(t.seatsWanted));
    if (want <= 0) return 0;
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
    return taken;
  };

  /* ── PHASE 1: THE RESERVATION ───────────────────────────────────────────
     Every opening feeder, before any other table of any game competes for the
     same horses. Explicit, so it no longer depends on the caller's sort. */
  const reservedByCluster = new Map<string, number>();
  for (const t of tables) {
    if (t.claim !== 'reserved') continue;
    const n = take({ ...t, seatsWanted: Math.min(t.seatsWanted, FEEDER_BUYERS_TO_GO_LIVE) });
    out.set(t.tableId, n);
    if (t.clusterId) {
      reservedByCluster.set(t.clusterId, (reservedByCluster.get(t.clusterId) ?? 0) + n);
    }
  }

  /* ── PHASE 2: EVERYTHING ELSE, in the caller's order ────────────────────
     A probe of a game that already holds a reservation reports THAT claim
     rather than booking a second set of horses for a feeder the tick cannot
     open while one is already `opening`. */
  for (const t of tables) {
    if (t.claim === 'reserved') continue;
    if (t.claim === 'probe' && t.clusterId && reservedByCluster.has(t.clusterId)) {
      out.set(
        t.tableId,
        Math.min(reservedByCluster.get(t.clusterId) ?? 0, Math.max(0, Math.floor(t.seatsWanted)))
      );
      continue;
    }
    out.set(t.tableId, take(t));
  }
  return out;
}
