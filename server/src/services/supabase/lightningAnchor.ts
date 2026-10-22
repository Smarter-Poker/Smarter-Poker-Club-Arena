/**
 * A LIGHTNING PLAYER'S ANCHOR SEAT, READ (Lightning Phase 6 remediation, 2026-10-01).
 *
 * A Lightning player's chips never leave the physical seat they entered the
 * pool from - `lightning_pool_session.anchor_seat_id` - so everything a
 * player does to their money from a Lightning room (leave, add chips) is done
 * to that seat, by the engine of the table it is at. These are READS only:
 * which seat, and the time bank that seat last persisted. They live here,
 * beside the other seat reads, rather than under src/lightning, whose law
 * forbids any Lightning source from touching a seat.
 */
import { supabase } from './client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export interface LightningAnchorSeat {
  anchorTableId: string;
  seatNumber: number;
  occupancyId: string;
  clusterId: string;
  completedHandOccupancyId?: string;
}

/**
 * The anchor seat behind a pool_session_id, when `userId` owns both the pool
 * session and the seat. Anything else (not a pool session, someone else's)
 * is null, so a caller can never be pointed at a seat that is not theirs.
 */
export async function lightningAnchorSeat(
  poolSessionId: string,
  userId: string,
  opts?: { requireOpen?: boolean; requireCompletedHand?: boolean }
): Promise<LightningAnchorSeat | null> {
  if (!isUuid(poolSessionId) || !isUuid(userId)) return null;
  const { data: session, error } = await supabase
    .from('lightning_pool_session')
    .select('player_id, cluster_id, anchor_seat_id, exited_at, cash_player_session_id, entered_at')
    .eq('id', poolSessionId)
    .maybeSingle();
  if (error) throw new Error(`lightning_pool_session read failed: ${error.message}`);
  const s = session as {
    player_id?: unknown;
    cluster_id?: unknown;
    anchor_seat_id?: unknown;
    exited_at?: unknown;
    cash_player_session_id?: unknown;
    entered_at?: unknown;
  } | null;
  if (
    !s ||
    s.player_id !== userId ||
    !isUuid(s.anchor_seat_id) ||
    !isUuid(s.cluster_id) ||
    (opts?.requireOpen && s.exited_at !== null)
  )
    return null;
  const { data: seat, error: seatError } = await supabase
    .from('table_seats')
    .select('table_id, seat_number, occupancy_id, user_id, left_at')
    .eq('id', s.anchor_seat_id)
    .maybeSingle();
  if (seatError) throw new Error(`anchor seat read failed: ${seatError.message}`);
  const row = seat as {
    table_id?: unknown;
    seat_number?: unknown;
    occupancy_id?: unknown;
    user_id?: unknown;
    left_at?: unknown;
  } | null;
  // A seat already vacated is still answered (same user, same occupancy), so
  // a retried leave finds its cash-out receipt; an add-on there is refused
  // by the engine, which owns that rule.
  if (
    !row ||
    row.user_id !== userId ||
    (opts?.requireOpen && row.left_at !== null) ||
    !isUuid(row.table_id) ||
    !isUuid(row.occupancy_id) ||
    !Number.isInteger(Number(row.seat_number))
  )
    return null;
  let completedHandOccupancyId: string | undefined;
  if (opts?.requireCompletedHand) {
    if (
      !isUuid(s.cash_player_session_id) ||
      typeof s.entered_at !== 'string' ||
      !Number.isFinite(Date.parse(s.entered_at))
    )
      return null;
    const cash = await supabase
      .from('cash_player_session')
      .select('id, opened_at')
      .eq('id', s.cash_player_session_id)
      .eq('player_id', userId)
      .eq('table_id', row.table_id)
      .is('closed_at', null)
      .maybeSingle();
    if (cash.error) throw new Error('Lightning sit-out cash identity read failed');
    if (
      !cash.data ||
      !Number.isFinite(Date.parse(cash.data.opened_at)) ||
      Date.parse(cash.data.opened_at) > Date.parse(s.entered_at)
    )
      return null;
    const slots = await supabase
      .from('lightning_pool_slot')
      .select('id')
      .eq('pool_session_id', poolSessionId)
      .eq('player_id', userId);
    if (slots.error) throw new Error('Lightning sit-out slot read failed');
    const slotIds = (slots.data ?? []).map((slot) => slot.id).filter(isUuid);
    if (!slotIds.length) return null;
    // stack_after is written only by atomic Lightning settlement, in the same
    // transaction as settled_at. Formation or a fold alone cannot qualify.
    const participant = await supabase
      .from('lightning_hand_player')
      .select('hand_id')
      .eq('player_id', userId)
      .in('pool_slot_id', slotIds)
      .not('stack_after', 'is', null)
      .limit(1)
      .maybeSingle();
    if (participant.error) throw new Error('Lightning sit-out participation read failed');
    if (!isUuid(participant.data?.hand_id)) return null;
    const hand = await supabase
      .from('lightning_hand')
      .select('hand_id')
      .eq('hand_id', participant.data.hand_id)
      .eq('cluster_id', s.cluster_id)
      .not('settled_at', 'is', null)
      .gte('settled_at', s.entered_at)
      .maybeSingle();
    if (hand.error) throw new Error('Lightning sit-out completed hand read failed');
    if (!hand.data) return null;
    // Fence every awaited proof against a closed pool or replaced occupancy.
    const current = await lightningAnchorSeat(poolSessionId, userId, { requireOpen: true });
    if (
      !current ||
      current.anchorTableId !== row.table_id ||
      current.occupancyId !== row.occupancy_id
    )
      return null;
    completedHandOccupancyId = row.occupancy_id;
  }
  return {
    ...(completedHandOccupancyId ? { completedHandOccupancyId } : {}),
    anchorTableId: row.table_id,
    seatNumber: Number(row.seat_number),
    occupancyId: row.occupancy_id,
    clusterId: s.cluster_id,
  };
}

/**
 * The time bank each player's anchor seat last persisted (the physical
 * engine's durable `time_bank_remaining` / `time_bank_uses_remaining`), for
 * the open pool sessions of `clusterId`. A Lightning worker seeds its ledger
 * from this on start, so a restart cannot hand a player a fresh bank.
 */
export async function lightningAnchorTimeBanks(
  clusterId: string,
  userIds: string[]
): Promise<Map<string, { remainingSeconds: number | null; usesRemaining: number | null }>> {
  const out = new Map<string, { remainingSeconds: number | null; usesRemaining: number | null }>();
  const ids = userIds.filter(isUuid);
  if (!isUuid(clusterId) || ids.length === 0) return out;
  const { data: sessions, error } = await supabase
    .from('lightning_pool_session')
    .select('player_id, anchor_seat_id')
    .eq('cluster_id', clusterId)
    .in('player_id', ids)
    .is('exited_at', null);
  if (error) throw new Error(`lightning_pool_session read failed: ${error.message}`);
  const seatToPlayer = new Map<string, string>();
  for (const r of (sessions ?? []) as Array<{ player_id?: unknown; anchor_seat_id?: unknown }>) {
    if (isUuid(r.player_id) && isUuid(r.anchor_seat_id))
      seatToPlayer.set(r.anchor_seat_id, r.player_id);
  }
  if (seatToPlayer.size === 0) return out;
  const { data: seats, error: seatError } = await supabase
    .from('table_seats')
    .select('id, user_id, time_bank_remaining, time_bank_uses_remaining')
    .in('id', [...seatToPlayer.keys()]);
  if (seatError) throw new Error(`anchor seat time bank read failed: ${seatError.message}`);
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  for (const r of (seats ?? []) as Array<Record<string, unknown>>) {
    const player = seatToPlayer.get(String(r.id));
    if (!player || r.user_id !== player) continue;
    out.set(player, {
      remainingSeconds: num(r.time_bank_remaining),
      usesRemaining: num(r.time_bank_uses_remaining),
    });
  }
  return out;
}

/**
 * Is this player in a live Lightning hand of this Cluster right now?
 * fn_lightning_player_live_hand answers the hand id or null. Throws when it
 * cannot answer, so a caller can fall back to the database's own guard.
 */
export async function lightningPlayerLiveHand(
  userId: string,
  clusterId: string
): Promise<string | null> {
  const { data, error } = await supabase.rpc('fn_lightning_player_live_hand', {
    p_player_id: userId,
    p_cluster_id: clusterId,
  });
  if (error) throw new Error(`fn_lightning_player_live_hand failed: ${error.message}`);
  return isUuid(data) ? data : null;
}

/** fn_cash_cluster_front_table: the Cluster's front table, the host every Lightning hand binds to. */
export async function lightningFrontTable(clusterId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('fn_cash_cluster_front_table', {
    p_game_id: clusterId,
  });
  if (error) throw new Error(`fn_cash_cluster_front_table failed: ${error.message}`);
  return isUuid(data) ? data : null;
}
