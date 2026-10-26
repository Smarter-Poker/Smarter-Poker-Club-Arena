/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THE HTTP HEARTBEAT IS ALLOWED TO BEAT AT (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * POST /heartbeat answers 404 "Table engine not found" for any id that is not
 * a table engine (server/src/handlers/heartbeat.ts: getTableEngine only).
 * Production, 24 hours to 2026-10-24, 1,864 such 404s:
 *
 *   - 666 were LIGHTNING POOL-SESSION ids (lightning_pool_session.id, no
 *     `tables` row). A pool-session room has no table engine to beat at;
 *     the room's presence is its own socket (LightningRegistry.connect /
 *     disconnect) and the anchor seat's engine. Every beat from such a room
 *     was a 404, every five seconds, for as long as the room was open.
 *   - 776 were tables whose row is CLOSED. The page only stopped beating
 *     after three engine-socket 4404s and a row read (the "This Table Is No
 *     Longer Running" verdict) - a table whose socket was never open, or one
 *     kept mounted behind another tab, never got there.
 *   - ~138 were RUNNING/WAITING Lightning-cluster tables, all inside a few
 *     minutes of an engine restart (engine /health 503s in the same window),
 *     while the new leader re-claimed its leases. That is the engine, not the
 *     client, and it is left alone here: a beat to a table coming back is the
 *     beat that should land.
 *
 * So: a Lightning room is never heartbeated over HTTP, and a 404 makes the
 * page ask the table row once; a closed or deleted row stops the beat until
 * the engine socket connects again.
 */

/** A pool-session room is presence-tracked by its socket, not /heartbeat. */
export function shouldHeartbeatOverHttp(input: { isLightningRoom: boolean }): boolean {
  return !input.isLightningRoom;
}

/** One bounded row read at the first404 of an absent-engine episode. */
export function shouldAskTableRow(consecutiveNotRunning: number): boolean {
  return consecutiveNotRunning === 1;
}

export interface HeartbeatRowCheck {
  status?: string | null;
  is_deleted?: boolean | null;
}

/**
 * Has the database said this table is over? Only a positive answer stops the
 * beat: a missing row, a failed read or a live status keeps beating, because a
 * beat that 404s costs one request and a beat withheld from a live table costs
 * the player their seat.
 */
export function tableRowSaysClosed(row: HeartbeatRowCheck | null | undefined): boolean {
  if (!row) return false;
  if (row.is_deleted === true) return true;
  const status = String(row.status ?? '').toLowerCase();
  return status === 'closed' || status === 'cancelled' || status === 'completed';
}
