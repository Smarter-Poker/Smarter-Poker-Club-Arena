export interface WakeableCashTableRow {
  tournament_id?: string | null;
  status?: string | null;
  game_type?: string | null;
  is_deleted?: boolean | null;
}

/**
 * A WebSocket may wake an engine only for a durable, non-deleted cash table
 * whose lifecycle still says it is open. Kept pure so every edge is pinned
 * without constructing the database-backed GameServer.
 */
export function isWakeableCashTable(table: WakeableCashTableRow | null): boolean {
  return Boolean(
    table &&
    table.tournament_id == null &&
    table.is_deleted !== true &&
    ['waiting', 'running', 'active'].includes(String(table.status).toLowerCase()) &&
    String(table.game_type ?? 'cash').toLowerCase() === 'cash'
  );
}
