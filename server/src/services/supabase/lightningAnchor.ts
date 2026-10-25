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

/** One seated occupancy, as the ended-session read needs it. */
export interface LightningSeatOccupancy {
  /** table_seats.id: what lightning_pool_session.anchor_seat_id names. */
  seatId: string;
  userId: string;
  /** table_seats.joined_at of THIS occupancy (a seat row can be re-owned). */
  joinedAt: string;
}

/**
 * THE SEATS WHOSE POOL SESSION ENDED WHILE THEIR OCCUPANT STAYED (2026-10-24).
 *
 * For a Cluster that IS Lightning right now (`cluster_mode` 'lightning' and
 * `lightning_enabled`), which of these occupancies entered the pool from this
 * very seat during this very occupancy, saw that pool session close, and has
 * no open pool session anywhere in the Cluster since. Answers seat id ->
 * the closed session's exit_reason. A seat that never entered the pool in
 * this occupancy is not here (nothing ended), nor is one whose player plays
 * on from another seat, nor any seat of a Cluster that is not Lightning (a
 * draining or frozen Cluster owns its own sessions).
 *
 * READS ONLY, and it throws when it cannot answer: an unreadable pool is not
 * an empty one, and the caller does nothing on a throw (10.86 rule 2).
 */
export async function lightningSeatsWhosePoolSessionEnded(
  clusterId: string,
  seats: LightningSeatOccupancy[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = seats.filter(
    (s) => isUuid(s.seatId) && isUuid(s.userId) && Number.isFinite(Date.parse(s.joinedAt))
  );
  if (!isUuid(clusterId) || valid.length === 0) return out;

  const { data: game, error: gameError } = await supabase
    .from('cash_games')
    .select('cluster_mode, lightning_enabled')
    .eq('id', clusterId)
    .maybeSingle();
  if (gameError) throw new Error(`cash_games read failed: ${gameError.message}`);
  const g = game as { cluster_mode?: unknown; lightning_enabled?: unknown } | null;
  if (!g || g.cluster_mode !== 'lightning' || g.lightning_enabled !== true) return out;

  const players = [...new Set(valid.map((s) => s.userId))];
  const { data: open, error: openError } = await supabase
    .from('lightning_pool_session')
    .select('player_id')
    .eq('cluster_id', clusterId)
    .in('player_id', players)
    .is('exited_at', null);
  if (openError) throw new Error(`lightning_pool_session read failed: ${openError.message}`);
  const playing = new Set(
    ((open ?? []) as Array<{ player_id?: unknown }>)
      .map((r) => r.player_id)
      .filter((v): v is string => isUuid(v))
  );

  const { data: closed, error: closedError } = await supabase
    .from('lightning_pool_session')
    .select('player_id, anchor_seat_id, entered_at, exit_reason')
    .eq('cluster_id', clusterId)
    .in(
      'anchor_seat_id',
      valid.map((s) => s.seatId)
    )
    .not('exited_at', 'is', null);
  if (closedError) throw new Error(`lightning_pool_session read failed: ${closedError.message}`);
  const rows = (closed ?? []) as Array<{
    player_id?: unknown;
    anchor_seat_id?: unknown;
    entered_at?: unknown;
    exit_reason?: unknown;
  }>;
  for (const seat of valid) {
    if (playing.has(seat.userId)) continue;
    const joined = Date.parse(seat.joinedAt);
    let latest: { at: number; reason: string } | null = null;
    for (const r of rows) {
      if (r.anchor_seat_id !== seat.seatId || r.player_id !== seat.userId) continue;
      const at = typeof r.entered_at === 'string' ? Date.parse(r.entered_at) : NaN;
      // Only a session THIS occupancy entered: a re-owned seat row keeps the
      // sessions of everyone who sat in it before.
      if (!Number.isFinite(at) || at < joined) continue;
      if (!latest || at > latest.at)
        latest = { at, reason: typeof r.exit_reason === 'string' ? r.exit_reason : 'unknown' };
    }
    if (latest) out.set(seat.seatId, latest.reason);
  }
  return out;
}
