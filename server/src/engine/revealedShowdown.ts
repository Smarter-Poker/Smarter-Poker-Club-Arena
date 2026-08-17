/**
 * Which showdown holdings a table is allowed to expose.
 *
 * Extracted 2026-08-17 so it can be unit-tested. It had been an inline filter
 * inside ServerTableEngineSettlement.postHandTasks, and it went wrong twice in
 * one day without CI noticing either time:
 *
 *   1. The gate did not exist on the persistence path at all, so hand_history
 *      stored the hole cards of players who mucked at showdown. Any participant
 *      of the hand could read them back (hand_history_authenticated_select).
 *      Measured: 3,953 losing holdings in one hour.
 *   2. The first fix read `currentHandWinnerIds`, which postHandTasks — fired
 *      without await — is guaranteed to see as empty. It filtered out every
 *      holding including the winners', silently emptying the column.
 *
 * Nothing asserted what hand_history stores, so both reached production. Hence
 * this module and its test.
 *
 * The rule: a holding may be exposed only if the table already showed it.
 * That is the winner, anyone who voluntarily showed, or everyone when the
 * table has auto-muck switched off.
 */
export interface ShowdownResultLike {
  userId: string;
}

export function selectRevealedShowdownResults<T extends ShowdownResultLike>(
  results: readonly T[],
  winnerIds: ReadonlySet<string>,
  showHandPlayers: ReadonlySet<string> | null | undefined,
  autoMuckEnabled: boolean
): T[] {
  // Auto-muck off: every showdown hand is turned face up at the table, so
  // there is nothing to withhold.
  if (!autoMuckEnabled) return [...results];

  return results.filter(
    (r) => winnerIds.has(r.userId) || (showHandPlayers?.has(r.userId) ?? false)
  );
}
