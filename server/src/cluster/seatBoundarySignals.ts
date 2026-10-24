/**
 * SEAT-BOUNDARY SIGNALS (2026-10-24). In-process, synchronous, never awaited.
 *
 * Dan 2026-10-23: "MAIN GAME MUST BE FED RIGHT AWAY WHEN A SEAT OPENS UP.
 * THERE SHOULDN'T BE A DELAY, NEXT HAND, PLAYER GOES TO THE MAIN GAME."
 *
 * #7873 made a must-move land at the first completed source boundary and
 * before the next feeder deal. Measured live on c485ce7a (2026-10-24 09:05-
 * 09:11 UTC, 18 natural moves), two residual races remained, both inside the
 * two-second rest (the-next-hand-deals-two-seconds-after-completion):
 *
 *   1. FEEDER. The pre-deal read runs at the START of the rest. A plan the
 *      ClusterController committed after that read - 0.9 s and 1.2 s before
 *      the deal in the two cases measured (moves 1440caa7, 4f1e32f4) - was
 *      invisible, so the player was dealt one more feeder hand.
 *   2. MAIN. The roster read also runs at the start of the rest. A player
 *      whose transfer committed after it (0.8 s and 1.4 s before Main's deal,
 *      moves 0152cb45, 1440caa7) sat out Main's very next hand.
 *
 * The planner, every feeder and every Main run in this one engine process, so
 * the cure is not another database read under the rest (the rest law forbids
 * any wait there): the side that changes the seat boundary bumps a counter
 * here the instant its committed RPC returns, and the dealing loop compares
 * the counters it captured before its reads with a synchronous check
 * immediately before dealHand. Only when one moved does the loop go round
 * once more - re-reading, moving the player or adopting the arrival - so an
 * ordinary deal still waits exactly the rest and nothing else.
 *
 * GRANULARITY. The planner reports how many moves it planned for a game, not
 * from which table, so plans are counted per GAME: every feeder of that game
 * re-reads once if a plan lands under its rest. Plans are a few per game per
 * hour, so an uninvolved feeder pays that re-read on well under 1% of its
 * deals, and the involved feeder never misses its boundary. Arrivals are
 * exact: the executor knows the destination table.
 *
 * Counters only grow and are keyed by a bounded set of ids (games and tables
 * this process runs), so nothing here needs pruning. A process restart starts
 * every counter at zero together with every engine's captured value.
 */

const plannedByGame = new Map<string, number>();
const arrivedByTable = new Map<string, number>();

/** The ClusterController committed at least one must-move plan for this game. */
export function noteMovesPlanned(gameId: string | null | undefined): void {
  if (!gameId) return;
  plannedByGame.set(gameId, (plannedByGame.get(gameId) ?? 0) + 1);
}

/** Captured before a feeder's pending-move read; compared before its deal. */
export function movesPlannedGeneration(gameId: string | null | undefined): number {
  return gameId ? (plannedByGame.get(gameId) ?? 0) : 0;
}

/** A seat move into this table committed (its executor RPC returned). */
export function noteSeatArrival(tableId: string | null | undefined): void {
  if (!tableId) return;
  arrivedByTable.set(tableId, (arrivedByTable.get(tableId) ?? 0) + 1);
}

/** Captured before a table's roster read; compared before its deal. */
export function seatArrivalGeneration(tableId: string | null | undefined): number {
  return tableId ? (arrivedByTable.get(tableId) ?? 0) : 0;
}

/**
 * fn_cash_cluster_tick reports `{ moves_planned: n }` among its actions when
 * it planned any (20260905 controller SQL). Anything unreadable is "no plan":
 * a missed signal only falls back to the pre-signal behaviour (the move lands
 * at the end of the hand that was dealt), never to a wrong move.
 */
export function tickReportsMovesPlanned(result: unknown): boolean {
  const actions = (result as { actions?: unknown } | null | undefined)?.actions;
  if (!Array.isArray(actions)) return false;
  return actions.some((action) => {
    const planned = (action as { moves_planned?: unknown } | null)?.moves_planned;
    return typeof planned === 'number' && planned > 0;
  });
}

/** Test seam only: production never resets a counter. */
export function resetSeatBoundarySignalsForTest(): void {
  plannedByGame.clear();
  arrivedByTable.clear();
}
