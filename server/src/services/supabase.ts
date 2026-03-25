/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SUPABASE CLIENT — Server-Side (Service Role)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Uses SERVICE_ROLE key for full database access — bypasses RLS.
 * Handles Realtime broadcasting from the server side.
 * ZERO browser dependencies. Runs on Node.js.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[Supabase] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set!');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE ROLE CLIENT — Full DB access, bypasses RLS
// ═══════════════════════════════════════════════════════════════════════════════

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// REALTIME BROADCASTING — Push hand state to all connected clients
// ═══════════════════════════════════════════════════════════════════════════════

// Channel cache to avoid creating new channels for every broadcast
const channelCache = new Map<string, ReturnType<SupabaseClient['channel']>>();

/**
 * Broadcast hand state to all table viewers via Supabase Realtime.
 * Uses the same channel naming as the client: `hand-state:{tableId}`
 */
export function broadcastHandState(tableId: string, handState: Record<string, unknown>): void {
  const channelName = `hand-state:${tableId}`;

  let channel = channelCache.get(channelName);
  if (!channel) {
    channel = supabase.channel(channelName);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        // Channel ready for broadcasting
      }
    });
    channelCache.set(channelName, channel);
  }

  channel
    .send({
      type: 'broadcast',
      event: 'hand_state',
      payload: handState,
    })
    .catch((err: unknown) => {
      console.warn(`[Broadcast] Failed to send hand state for ${tableId}:`, err);
    });
}

/**
 * Clean up a channel when a table is no longer active
 */
export function cleanupChannel(tableId: string): void {
  const channelName = `hand-state:${tableId}`;
  const channel = channelCache.get(channelName);
  if (channel) {
    supabase.removeChannel(channel);
    channelCache.delete(channelName);
  }
}

/**
 * Clean up all channels on shutdown
 */
export function cleanupAllChannels(): void {
  for (const [name, channel] of channelCache) {
    supabase.removeChannel(channel);
  }
  channelCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE HELPERS — Common queries used by the engine
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load table info from database
 */
export async function loadTable(tableId: string) {
  const { data, error } = await supabase
    .from('tables')
    .select(
      'id, club_id, small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, time_bank_seconds, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, run_it_twice_enabled, insurance_enabled, auto_muck_enabled, show_hand_enabled, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses'
    )
    .eq('id', tableId)
    .single();

  if (error) throw new Error(`Failed to load table ${tableId}: ${error.message}`);
  return data;
}

/**
 * Load seated players with profiles for a table
 */
export async function loadSeatedPlayers(tableId: string) {
  const { data: seats, error } = await supabase
    .from('table_seats')
    .select('user_id, stack, seat_number, time_bank_remaining, time_bank_uses_remaining')
    .eq('table_id', tableId)
    .is('left_at', null)
    .order('seat_number', { ascending: true });

  if (error || !seats || seats.length === 0) return [];

  const userIds = seats.map((d) => d.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, display_name, username, is_horse, horse_profile, avatar_url')
    .in('id', userIds);

  const profileMap = new Map(profiles?.map((p) => [p.id, p]) || []);

  return seats
    .filter((seat) => profileMap.has(seat.user_id))
    .map((seat) => {
      const profile = profileMap.get(seat.user_id)!;
      return {
        user_id: seat.user_id,
        username: profile.display_name || profile.username || 'Player',
        stack: seat.stack,
        seat_number: seat.seat_number || 1,
        is_horse: profile.is_horse || false,
        horse_profile: profile.horse_profile || 'balanced',
        time_bank_remaining: seat.time_bank_remaining || 0,
        time_bank_uses_remaining: seat.time_bank_uses_remaining || 0,
        avatar_url: profile.avatar_url || '',
      };
    });
}

/**
 * Sync player stacks back to database after a hand
 */
export async function syncStacks(
  tableId: string,
  players: { user_id: string; stack: number; time_bank_uses_remaining?: number }[]
): Promise<void> {
  const results = await Promise.allSettled(
    players.map((player) => {
      const updatePayload: any = { stack: player.stack };
      if (player.time_bank_uses_remaining !== undefined) {
        updatePayload.time_bank_uses_remaining = player.time_bank_uses_remaining;
      }
      return supabase
        .from('table_seats')
        .update(updatePayload)
        .eq('table_id', tableId)
        .eq('user_id', player.user_id)
        .is('left_at', null);
    })
  );
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    console.error(
      `[DB] ${failures.length}/${players.length} stack syncs failed for table ${tableId}`
    );
  }
}

/**
 * Sync tournament player chips from table_seats to tournament_players
 */
export async function syncTournamentChips(tableId: string, tournamentId: string): Promise<void> {
  const { data: seats } = await supabase
    .from('table_seats')
    .select('user_id, stack')
    .eq('table_id', tableId)
    .is('left_at', null);

  if (!seats || seats.length === 0) return;

  await Promise.allSettled(
    seats.map(async (seat) => {
      const exact = Math.trunc(seat.stack * 100) / 100;
      await supabase
        .from('tournament_players')
        .update({ chips: exact })
        .eq('tournament_id', tournamentId)
        .eq('user_id', seat.user_id);
    })
  );
}

/**
 * Update table player count and status
 */
export async function updateTableStatus(
  tableId: string,
  playerCount: number,
  status: string = 'running'
): Promise<void> {
  await supabase.from('tables').update({ current_players: playerCount, status }).eq('id', tableId);
}

/**
 * Auto-rebuy a horse from their Player Wallet atomically
 */
export async function autoRebuyHorse(
  tableId: string,
  userId: string,
  rebuyAmount: number,
  clubId: string
): Promise<boolean> {
  const { error } = await supabase.rpc('atomic_table_rebuy', {
    p_user_id: userId,
    p_table_id: tableId,
    p_amount: rebuyAmount,
  });

  if (error) {
    if (
      !error.message.includes('Insufficient balance') &&
      !error.message.includes('Active seat not found')
    ) {
      console.error(`[DB] Unexpected atomic auto-rebuy failure for ${userId}:`, error.message);
    }
    return false;
  }

  return true;
}

/**
 * Mark a horse as having left the table, cash them out atomically, and sync players count.
 */
export async function markSeatAsLeft(
  tableId: string,
  userId: string,
  seatNumber: number
): Promise<void> {
  const { error: txErr } = await supabase.rpc('atomic_table_cashout', {
    p_user_id: userId,
    p_table_id: tableId,
    p_seat_number: seatNumber,
  });

  if (txErr) {
    console.warn(`[DB] Failed to atomic cash-out horse ${userId} at ${tableId}:`, txErr.message);
    // Fallback to old simple update if the stack was already 0 or an anomaly occurred
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);
  }
}

/**
 * Process leave-pending players after hand completion
 */
export async function processLeavePending(tableId: string, clubId: string): Promise<void> {
  const { data: pendingSeats } = await supabase
    .from('table_seats')
    .select('user_id, stack, seat_number')
    .eq('table_id', tableId)
    .eq('leave_pending', true)
    .is('left_at', null);

  if (!pendingSeats || pendingSeats.length === 0) return;

  for (const seat of pendingSeats) {
    // Use atomic cashout — credits wallet + marks left + updates count in one transaction
    const { error: cashoutErr } = await supabase.rpc('atomic_table_cashout', {
      p_user_id: seat.user_id,
      p_table_id: tableId,
      p_seat_number: seat.seat_number,
    });

    if (cashoutErr) {
      console.error(
        `[processLeavePending] Atomic cashout failed for ${seat.user_id}: ${cashoutErr.message}`
      );
      // Fallback: if stack is 0, just mark as left
      if (seat.stack === 0) {
        await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString(), leave_pending: false })
          .eq('table_id', tableId)
          .eq('user_id', seat.user_id)
          .eq('seat_number', seat.seat_number)
          .is('left_at', null);
      }
      // If stack > 0 and cashout failed, leave them seated to prevent chip loss
    }
  }

  // Authoritative recount after all departures
  const { count } = await supabase
    .from('table_seats')
    .select('*', { count: 'exact', head: true })
    .eq('table_id', tableId)
    .is('left_at', null);

  await supabase
    .from('tables')
    .update({ current_players: count || 0 })
    .eq('id', tableId);
}

/**
 * Log rake collection — every chip documented.
 * Rake goes to union owner (if club is in a union) or club owner (standalone).
 * Union holds all rake and distributes 90% back to clubs weekly.
 */
export async function logRakeCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  rakeAmount: number,
  potAmount: number
): Promise<void> {
  if (rakeAmount <= 0) return;

  // Log to rake_history (hand-level rake record — always)
  const { error: rakeErr } = await supabase.from('rake_history').insert({
    table_id: tableId,
    club_id: clubId,
    hand_number: handNumber,
    rake_amount: rakeAmount,
    pot_amount: potAmount,
    collected_at: new Date().toISOString(),
  });
  if (rakeErr) console.warn(`[DB] Failed to log rake for hand #${handNumber}:`, rakeErr.message);

  // Credit rake to the correct wallet: union owner or standalone club owner
  try {
    const { data: club } = await supabase
      .from('clubs')
      .select('owner_id, union_id, name')
      .eq('id', clubId)
      .single();

    if (!club) return;

    let rakeRecipientId: string | null = null;
    let rakeDesc = '';

    if (club.union_id) {
      // Club is in a union — rake held by union owner until weekly settlement
      const { data: union } = await supabase
        .from('unions')
        .select('owner_id, name')
        .eq('id', club.union_id)
        .single();

      if (union?.owner_id) {
        rakeRecipientId = union.owner_id;
        rakeDesc = `Cash game rake held by ${union.name || 'Union'}: hand #${handNumber} (${club.name || 'club'})`;
      }
    } else {
      // Standalone club — rake goes directly to club owner
      rakeRecipientId = club.owner_id;
      rakeDesc = `Cash game rake: hand #${handNumber}`;
    }

    if (rakeRecipientId) {
      // Credit to recipient's PLAYER wallet
      const { error: rakeCredErr } = await supabase.rpc('credit_player_wallet', {
        p_user_id: rakeRecipientId,
        p_amount: rakeAmount,
      });

      if (rakeCredErr) {
        console.error(
          `[logRakeCollection] Rake credit failed for ${rakeRecipientId}: ${rakeCredErr.message}`
        );
      } else {
        // Log wallet transaction only on successful credit
        const { error: txErr } = await supabase.rpc('log_wallet_transaction', {
          p_user_id: rakeRecipientId,
          p_wallet_type: 'PLAYER',
          p_amount: rakeAmount,
          p_type: 'credit',
          p_category: 'rake',
          p_description: rakeDesc,
          p_table_id: tableId,
          p_hand_id: null,
          p_related_entity_id: clubId,
        });
        if (txErr) console.error(`[logRakeCollection] Rake tx log failed: ${txErr.message}`);
      }
    }
  } catch (e) {
    console.warn(`[DB] Rake wallet credit failed for hand #${handNumber}:`, e);
  }
}

/**
 * Log BBJ contribution — splits fee into main/backup/promo pools per allocation.
 * BBJ pool ownership: union-level (if club is in union) or club-level (standalone).
 * Allocation: 40% Main, 30% Backup, 30% Promotional (from authoritative RakeConfig).
 */
export async function logBBJCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  bbjAmount: number,
  bigBlind: number
): Promise<void> {
  if (bbjAmount <= 0) return;

  try {
    // Find the BBJ pool for this club (or its union)
    const { data: club } = await supabase
      .from('clubs')
      .select('union_id')
      .eq('id', clubId)
      .maybeSingle();

    if (!club) {
      console.warn(`[logBBJCollection] Club ${clubId} not found — skipping BBJ logging`);
      return;
    }

    // Look up pool: union-level first, then club-level
    let poolQuery = supabase.from('bbj_pools').select('id');
    if (club.union_id) {
      poolQuery = poolQuery.eq('union_id', club.union_id);
    } else {
      poolQuery = poolQuery.eq('club_id', clubId);
    }
    const { data: pool } = await poolQuery.maybeSingle();

    if (!pool) {
      console.warn(`[logBBJCollection] No BBJ pool found for club ${clubId} — skipping`);
      return;
    }

    // Allocation: 40% Main, 30% Backup, 30% Promotional
    const mainPortion = Math.round(bbjAmount * 0.4 * 100) / 100;
    const backupPortion = Math.round(bbjAmount * 0.3 * 100) / 100;
    const promoPortion = Math.round(bbjAmount * 100) / 100 - mainPortion - backupPortion;

    // Use bbj_record_contribution RPC — atomically updates pool balances + logs contribution
    // hand_id is nullable (migration 20260325) since server uses hand_history not hands table
    const { error } = await supabase.rpc('bbj_record_contribution', {
      p_pool_id: pool.id,
      p_hand_id: null,
      p_table_id: tableId,
      p_amount: bbjAmount,
      p_main_portion: mainPortion,
      p_backup_portion: backupPortion,
      p_promo_portion: promoPortion,
      p_big_blind: bigBlind,
      p_hand_number: handNumber,
    });

    if (error) {
      console.error(
        `[logBBJCollection] BBJ contribution RPC failed for hand #${handNumber}:`,
        error.message
      );
    }
  } catch (e) {
    console.warn(`[logBBJCollection] BBJ logging failed for hand #${handNumber}:`, e);
  }
}

/**
 * Log insurance settlement — Bible V8 §4.19.
 * Records premium collection and payout, routed to union bank or club bank.
 * - Union clubs: premiums/payouts flow through union bank
 * - Standalone clubs: premiums/payouts flow through club main bank
 */
export async function logInsuranceSettlement(params: {
  tableId: string;
  clubId: string;
  handNumber: number;
  playerId: string;
  equityPercent: number;
  premium: number;
  insuredAmount: number;
  payout: number;
  playerWon: boolean;
}): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_insurance_transaction', {
      p_table_id: params.tableId,
      p_club_id: params.clubId,
      p_hand_number: params.handNumber,
      p_player_id: params.playerId,
      p_equity_percent: params.equityPercent,
      p_premium: params.premium,
      p_insured_amount: params.insuredAmount,
      p_payout: params.payout,
      p_player_won: params.playerWon,
    });

    if (error) {
      console.error(
        `[logInsuranceSettlement] RPC failed for player ${params.playerId} hand #${params.handNumber}:`,
        error.message
      );
    }
  } catch (e) {
    console.warn(`[logInsuranceSettlement] Failed for hand #${params.handNumber}:`, e);
  }
}

/**
 * Log hand history — every hand documented for audit and replay.
 */
export async function logHandHistory(params: {
  tableId: string;
  tournamentId?: string;
  handNumber: number;
  gameVariant: string;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount: number;
  bbjAmount?: number;
  communityCards: string[];
  winners: { userId: string; amount: number }[];
  players: { userId: string; username: string; seat: number; stack: number; cards: string[] }[];
  actions: { seat: number; action: string; amount?: number; stage: string }[];
}): Promise<void> {
  const { error } = await supabase.from('hand_history').insert({
    table_id: params.tableId,
    tournament_id: params.tournamentId || null,
    hand_number: params.handNumber,
    game_variant: params.gameVariant,
    small_blind: params.smallBlind,
    big_blind: params.bigBlind,
    pot_size: params.potSize,
    rake_amount: params.rakeAmount,
    bbj_amount: params.bbjAmount || 0,
    community_cards: params.communityCards,
    winners: params.winners,
    players: params.players,
    actions: params.actions,
  });
  if (error) {
    console.warn(`[DB] Failed to log hand history #${params.handNumber}:`, error.message);
  }
}

/**
 * Ensure a horse's wallet is properly funded.
 * Called during fleet startup to top up horses that ran low.
 */
export async function ensureHorseWallet(
  horseId: string,
  minBalance: number = 10000
): Promise<void> {
  const { data: wallet } = await supabase
    .from('wallets')
    .select('id, balance')
    .eq('user_id', horseId)
    .eq('wallet_type', 'PLAYER')
    .maybeSingle();

  if (!wallet) {
    // Create wallet
    await supabase.from('wallets').insert({
      user_id: horseId,
      wallet_type: 'PLAYER',
      balance: minBalance,
      locked_balance: 0,
    });
    return;
  }

  if (wallet.balance < minBalance) {
    const topUp = minBalance - wallet.balance;
    const { error: refillErr } = await supabase.rpc('credit_player_wallet', {
      p_user_id: horseId,
      p_amount: topUp,
    });

    if (refillErr) {
      console.error(`[refillHorseWallet] Credit failed for horse ${horseId}: ${refillErr.message}`);
      return;
    }

    const { error: refillTxErr } = await supabase.from('wallet_transactions').insert({
      user_id: horseId,
      wallet_type: 'PLAYER',
      amount: topUp,
      type: 'credit',
      category: 'horse_refill',
      description: `Horse wallet refill: ${topUp} chips (balance was ${wallet.balance})`,
    });
    if (refillTxErr)
      console.warn(
        `[DB] Horse refill tx log failed for ${horseId.slice(0, 8)}: ${refillTxErr.message}`
      );
  }
}

/**
 * Process BBJ payout — fetch pool balance, calculate shares, deduct from pool,
 * record payout in bbj_payouts + bbj_payout_recipients, and return amounts.
 *
 * Returns null if pool not found or balance is zero.
 * Chips are credited to players' table stacks by ServerTableEngine after this returns.
 */
export async function processBBJPayout(params: {
  tableId: string;
  clubId: string;
  handNumber: number;
  loserUserId: string;
  winnerUserId: string;
  loserHandName: string;
  winnerHandName: string;
  dealtInPlayerIds: string[];
  payoutTotalPercent: number; // e.g., 55 for Mid stakes = 55% of main pool
}): Promise<{
  totalPayout: number;
  loserShare: number;
  winnerShare: number;
  tableShare: number;
  perPlayerShare: number;
  poolId: string;
} | null> {
  try {
    // 1. Find the club's union (if any)
    const { data: club } = await supabase
      .from('clubs')
      .select('union_id')
      .eq('id', params.clubId)
      .maybeSingle();

    if (!club) {
      console.warn(`[processBBJPayout] Club ${params.clubId} not found`);
      return null;
    }

    // 2. Find the BBJ pool (union-level first, then club-level)
    let poolQuery = supabase.from('bbj_pools').select('id, main_balance, backup_balance');
    if (club.union_id) {
      poolQuery = poolQuery.eq('union_id', club.union_id);
    } else {
      poolQuery = poolQuery.eq('club_id', params.clubId);
    }
    const { data: pool } = await poolQuery.maybeSingle();

    if (!pool || pool.main_balance <= 0) {
      console.warn(`[processBBJPayout] No BBJ pool or zero balance for club ${params.clubId}`);
      return null;
    }

    // 3. Calculate payout amounts from the MAIN pool balance
    const totalPayout =
      Math.round(pool.main_balance * (params.payoutTotalPercent / 100) * 100) / 100;
    const loserShare = Math.round(totalPayout * 0.5 * 100) / 100; // 50% to loser (bad beat holder)
    const winnerShare = Math.round(totalPayout * 0.25 * 100) / 100; // 25% to winner
    const tableShareTotal = Math.round((totalPayout - loserShare - winnerShare) * 100) / 100; // 25% to table

    // Table share split equally among all dealt-in players (excluding loser and winner who already get shares)
    const tableOnlyPlayers = params.dealtInPlayerIds.filter(
      (id) => id !== params.loserUserId && id !== params.winnerUserId
    );
    const perPlayerShare =
      tableOnlyPlayers.length > 0
        ? Math.round((tableShareTotal / tableOnlyPlayers.length) * 100) / 100
        : 0;

    // 4. Deduct from pool main_balance and update stats (read-then-increment for correct totals)
    const { data: poolStats } = await supabase
      .from('bbj_pools')
      .select('total_paid_out, hit_count')
      .eq('id', pool.id)
      .maybeSingle();

    const currentTotalPaidOut = Number(poolStats?.total_paid_out ?? 0);
    const currentHitCount = Number(poolStats?.hit_count ?? 0);

    const { error: poolErr } = await supabase
      .from('bbj_pools')
      .update({
        main_balance: Math.max(0, pool.main_balance - totalPayout),
        total_paid_out: currentTotalPaidOut + totalPayout,
        hit_count: currentHitCount + 1,
        last_hit_at: new Date().toISOString(),
        last_hit_amount: totalPayout,
        last_winner_id: params.loserUserId, // "winner" in BBJ terms = the bad beat loser
        last_loser_id: params.winnerUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pool.id);

    if (poolErr) {
      console.error(`[processBBJPayout] Pool update failed:`, poolErr.message);
      return null;
    }

    // 5. Record the payout in bbj_payouts table
    // hand_id is NULL (server uses hand_history table, not legacy hands table)
    // hand_number + table_id provide the reference instead
    const { data: payoutRecord, error: payoutErr } = await supabase
      .from('bbj_payouts')
      .insert({
        pool_id: pool.id,
        hand_id: null, // Nullable after migration 20260325_bbj_payouts_hand_id_nullable
        table_id: params.tableId,
        hand_number: params.handNumber,
        winner_user_id: params.loserUserId, // BBJ "winner" = the bad beat loser (gets 50%)
        loser_user_id: params.winnerUserId, // BBJ "loser" = the hand winner (gets 25%)
        total_amount: totalPayout,
        winner_share: loserShare,
        loser_share: winnerShare,
        table_share: tableShareTotal,
        table_player_count: params.dealtInPlayerIds.length,
        winner_hand_name: params.loserHandName,
        loser_hand_name: params.winnerHandName,
        status: 'completed',
      })
      .select('id')
      .maybeSingle();

    if (payoutErr) {
      console.error(`[processBBJPayout] Payout record failed:`, payoutErr.message);
    }

    // 6. Record individual table share recipients
    if (payoutRecord && tableOnlyPlayers.length > 0) {
      const recipients = tableOnlyPlayers.map((userId) => ({
        payout_id: payoutRecord.id,
        user_id: userId,
        amount: perPlayerShare,
      }));
      const { error: recipErr } = await supabase.from('bbj_payout_recipients').insert(recipients);
      if (recipErr) {
        console.warn(`[processBBJPayout] Recipient logging failed:`, recipErr.message);
      }
    }

    // 7. Also record in bbj_winners table for the "Previous Winners" display
    await supabase
      .from('bbj_winners')
      .insert({
        pool_id: pool.id,
        user_id: params.loserUserId, // The "winner" of the BBJ (bad beat holder)
        amount: totalPayout,
        hand_name: params.loserHandName,
        table_id: params.tableId,
      })
      .then(({ error }) => {
        if (error) console.warn(`[processBBJPayout] bbj_winners insert failed:`, error.message);
      });

    console.log(
      `[processBBJPayout] BBJ HIT! Pool ${pool.id}: $${totalPayout} total ` +
        `(loser=$${loserShare}, winner=$${winnerShare}, table=$${tableShareTotal} / ${tableOnlyPlayers.length} players)`
    );

    return {
      totalPayout,
      loserShare,
      winnerShare,
      tableShare: tableShareTotal,
      perPlayerShare,
      poolId: pool.id,
    };
  } catch (e) {
    console.error(`[processBBJPayout] Fatal error:`, e);
    return null;
  }
}

export default supabase;
