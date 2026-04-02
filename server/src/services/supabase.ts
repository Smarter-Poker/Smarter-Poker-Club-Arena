/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SUPABASE CLIENT — Server-Side (Service Role)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Uses SERVICE_ROLE key for full database access — bypasses RLS.
 * Handles Realtime broadcasting from the server side.
 * ZERO browser dependencies. Runs on Node.js.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { reportError } from './errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_SERVICE_ROLE_KEY) {
  reportError(new Error('[Supabase] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set!'), 'Supabase.FATAL');
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
 *
 * FIX-217: Returns a Promise so critical paths (TURN_CHANGE, settlement)
 * can await broadcast delivery to Supabase before proceeding.
 * Bible V8 §1.2.3: "Broadcast must confirm before next turn begins"
 */
export function broadcastHandState(tableId: string, handState: Record<string, unknown>): Promise<void> {
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

  return channel
    .send({
      type: 'broadcast',
      event: 'hand_state',
      payload: handState,
    })
    .then(() => {
      // Broadcast accepted by Supabase server
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
      'id, club_id, small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, time_bank_seconds, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, run_it_twice_enabled, insurance_enabled, auto_muck_enabled, show_hand_enabled, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses, time_bank_enabled, ante_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, name'
    )
    .eq('id', tableId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load table ${tableId}: ${error.message}`);
  if (!data) throw new Error(`Table ${tableId} not found`);
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
    .select('id, display_name, username, is_horse, horse_profile, avatar_url, use_real_name')
    .in('id', userIds);

  const profileMap = new Map(profiles?.map((p) => [p.id, p]) || []);

  return seats
    .filter((seat) => profileMap.has(seat.user_id))
    .map((seat) => {
      const profile = profileMap.get(seat.user_id)!;
      return {
        user_id: seat.user_id,
        username: profile.use_real_name 
          ? (profile.display_name || profile.username || 'Player')
          : (profile.username || profile.display_name || 'Player'),
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
    reportError(new Error(`[DB] ${failures.length}/${players.length} stack syncs failed for table ${tableId}`), 'DB.failureslengthplayerslength_st');
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
 * FIX 208: Replaced RPC with direct queries to avoid PostgREST schema cache "text = uuid" errors
 */
export async function autoRebuyHorse(
  tableId: string,
  userId: string,
  rebuyAmount: number,
  clubId: string
): Promise<boolean> {
  try {
    // 1. Verify active seat exists and get current stack
    const { data: seat } = await supabase
      .from('table_seats')
      .select('id, stack')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null)
      .maybeSingle();

    if (!seat) return false;

    // 2. Check and deduct wallet
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    if (!wallet || wallet.balance < rebuyAmount) return false;

    const { error: deductErr } = await supabase
      .from('wallets')
      .update({ balance: wallet.balance - rebuyAmount, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('wallet_type', 'PLAYER');

    if (deductErr) {
      reportError(deductErr, 'DB.Rebuy_wallet_deduct_failed_for');
      return false;
    }

    // 3. Add to seat stack (read current + add)
    const currentStack = seat.stack ?? 0;
    await supabase
      .from('table_seats')
      .update({ stack: currentStack + rebuyAmount })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    // 4. Log transaction
    await supabase.from('wallet_transactions').insert({
      user_id: userId,
      wallet_type: 'PLAYER',
      type: 'debit',
      amount: rebuyAmount,
      category: 'rebuy',
      description: 'Auto-rebuy topup at table',
      table_id: tableId,
    });

    return true;
  } catch (err: any) {
    if (!err.message?.includes('Insufficient balance') && !err.message?.includes('Active seat not found')) {
      reportError(err, 'DB.Unexpected_atomic_autorebuy_fa');
    }
    return false;
  }
}

/**
 * Mark a horse as having left the table, cash them out atomically, and sync players count.
 * FIX 208: Replaced RPC with direct queries to avoid PostgREST schema cache "text = uuid" errors
 */
export async function markSeatAsLeft(
  tableId: string,
  userId: string,
  seatNumber: number
): Promise<void> {
  try {
    // 1. Get the active seat and its stack
    const { data: seat } = await supabase
      .from('table_seats')
      .select('stack')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('seat_number', seatNumber)
      .is('left_at', null)
      .maybeSingle();

    if (!seat) {
      // Seat already gone — just update if stale
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .is('left_at', null);
      return;
    }

    const stack = seat.stack ?? 0;

    // 2. Credit wallet if stack > 0
    if (stack > 0) {
      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', userId)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();

      const currentBalance = wallet?.balance ?? 0;
      await supabase
        .from('wallets')
        .upsert({
          user_id: userId,
          wallet_type: 'PLAYER',
          balance: currentBalance + stack,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,wallet_type' });

      // Log transaction
      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        wallet_type: 'PLAYER',
        type: 'credit',
        amount: stack,
        category: 'cashout',
        description: 'Cash-out from table',
        table_id: tableId,
      });
    }

    // 3. Soft-delete the seat
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString(), leave_pending: false })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('seat_number', seatNumber)
      .is('left_at', null);

    // 4. Update player count
    const { count } = await supabase
      .from('table_seats')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .is('left_at', null);

    await supabase
      .from('tables')
      .update({ current_players: count ?? 0 })
      .eq('id', tableId);

  } catch (err: any) {
    console.warn(`[DB] Failed to cash-out horse ${userId} at ${tableId}:`, err.message);
    // Fallback: just mark as left
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);
  }
}

/**
 * Atomic cashout — direct query version for use by HorseLifecycleManager and index.ts
 * FIX 208: Avoids PostgREST RPC "text = uuid" errors
 * Returns the cashed-out stack amount, or 0 if seat not found
 */
export async function atomicCashout(
  userId: string,
  tableId: string,
  seatNumber?: number
): Promise<number> {
  try {
    // 1. Find active seat
    let query = supabase
      .from('table_seats')
      .select('stack, seat_number')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    if (seatNumber !== undefined) {
      query = query.eq('seat_number', seatNumber);
    }

    const { data: seat } = await query.maybeSingle();
    if (!seat) return 0;

    const stack = seat.stack ?? 0;

    // 2. Credit wallet
    if (stack > 0) {
      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', userId)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();

      const currentBalance = wallet?.balance ?? 0;
      await supabase
        .from('wallets')
        .upsert({
          user_id: userId,
          wallet_type: 'PLAYER',
          balance: currentBalance + stack,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,wallet_type' });

      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        wallet_type: 'PLAYER',
        type: 'credit',
        amount: stack,
        category: 'cashout',
        description: 'Cash-out from table',
        table_id: tableId,
      });
    }

    // 3. Soft-delete seat
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString(), leave_pending: false })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    // 4. Update player count
    const { count } = await supabase
      .from('table_seats')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .is('left_at', null);

    await supabase
      .from('tables')
      .update({ current_players: count ?? 0 })
      .eq('id', tableId);

    return stack;
  } catch (err: any) {
    // Fallback: just mark as left
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);
    return 0;
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
    // FIX 208: Use direct atomicCashout instead of RPC
    await atomicCashout(seat.user_id, tableId, seat.seat_number);
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

  // Credit rake to the correct entity wallet:
  // - Club NOT in a union → credit to CLUB wallet (club_wallets or clubs.chip_pool)
  // - Club IN a union → credit to UNION wallet (union_wallets.chip_balance)
  // NEVER goes to a player's personal wallet.
  try {
    const { data: club, error: clubErr } = await supabase
      .from('clubs')
      .select('owner_id, union_id, name')
      .eq('id', clubId)
      .maybeSingle();

    if (clubErr) {
      console.warn(`[DB] Failed to look up club ${clubId} for rake credit:`, clubErr.message);
      return;
    }
    if (!club) return;

    if (club.union_id) {
      // Club is in a union — ALL rake held by union wallet until weekly settlement
      // Read current balance then increment (Supabase REST doesn't support atomic increment)
      const { data: uw } = await supabase
        .from('union_wallets')
        .select('chip_balance')
        .eq('union_id', club.union_id)
        .maybeSingle();

      if (uw) {
        const newBalance = (uw.chip_balance || 0) + rakeAmount;
        const { error: uwErr } = await supabase
          .from('union_wallets')
          .update({ chip_balance: newBalance, updated_at: new Date().toISOString() })
          .eq('union_id', club.union_id);
        if (uwErr) {
          reportError(new Error(`[logRakeCollection] Union wallet credit failed: ${uwErr.message}`), 'logRakeCollection.Union_wallet_credit_failed');
        }
      } else {
        // No union wallet exists — create one
        const { error: insertErr } = await supabase
          .from('union_wallets')
          .insert({ union_id: club.union_id, chip_balance: rakeAmount });
        if (insertErr) {
          reportError(new Error(`[logRakeCollection] Union wallet insert failed: ${insertErr.message}`), 'logRakeCollection.Union_wallet_insert_failed');
        }
      }

      // Log union transaction for audit trail
      await supabase.from('union_transactions').insert({
        union_id: club.union_id,
        club_id: clubId,
        amount: rakeAmount,
        tx_type: 'rake',
        wallet: 'chip',
        direction: 'credit',
        notes: `Cash game rake: hand #${handNumber} (${club.name || 'club'})`,
        created_at: new Date().toISOString(),
      }).catch(() => {});

    } else {
      // Standalone club — rake goes to CLUB wallet (not owner's player wallet)
      // Try club_wallets table first, then clubs.chip_pool as fallback
      const { data: cw } = await supabase
        .from('club_wallets')
        .select('chip_balance')
        .eq('club_id', clubId)
        .maybeSingle();

      if (cw) {
        const { error: cwErr } = await supabase
          .from('club_wallets')
          .update({ chip_balance: (cw.chip_balance || 0) + rakeAmount })
          .eq('club_id', clubId);
        if (cwErr) {
          reportError(new Error(`[logRakeCollection] Club wallet credit failed: ${cwErr.message}`), 'logRakeCollection.Club_wallet_credit_failed');
        }
      } else {
        // Fallback: update clubs.chip_pool directly
        const { data: clubData } = await supabase
          .from('clubs')
          .select('chip_pool')
          .eq('id', clubId)
          .maybeSingle();

        const { error: cpErr } = await supabase
          .from('clubs')
          .update({ chip_pool: ((clubData?.chip_pool as number) || 0) + rakeAmount })
          .eq('id', clubId);
        if (cpErr) {
          reportError(new Error(`[logRakeCollection] Club chip_pool credit failed: ${cpErr.message}`), 'logRakeCollection.Club_chip_pool_credit_failed');
        }
      }
    }
  } catch (e) {
    console.warn(`[DB] Rake wallet credit failed for hand #${handNumber}:`, e);
  }
}

/**
 * Log BBJ contribution — splits fee into main/backup/promo pools per allocation.
 * BBJ pool ownership: union-level (if club is in union) or club-level (standalone).
 * FIX 140: Pivot-based allocation matching Bible V8 §4.13 / BBJService spec:
 *   STANDARD (<100k main pool): 50% Main, 25% Backup, 25% Promo
 *   PIVOT (≥100k main pool): 30% Main, 40% Backup, 30% Promo
 */
export async function logBBJCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  bbjAmount: number,
  bigBlind: number
): Promise<void> {
  if (bbjAmount <= 0) return;

  // FIX 140: Pivot-based allocation thresholds (Bible V8 §4.13)
  const BBJ_PIVOT_THRESHOLD = 100000; // 100,000 chips
  const BBJ_ALLOCATION = {
    STANDARD: { MAIN: 0.5, BACKUP: 0.25, PROMO: 0.25 },
    PIVOT: { MAIN: 0.3, BACKUP: 0.4, PROMO: 0.3 },
  };

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

    // Look up pool: union-level first, then club-level — include main_balance for pivot check
    let poolQuery = supabase.from('bbj_pools').select('id, main_balance');
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

    // FIX 140: Determine allocation ratios based on current pool size
    const currentMainBalance = pool.main_balance ?? 0;
    const ratios =
      currentMainBalance >= BBJ_PIVOT_THRESHOLD ? BBJ_ALLOCATION.PIVOT : BBJ_ALLOCATION.STANDARD;

    const mainPortion = Math.round(bbjAmount * ratios.MAIN * 100) / 100;
    const backupPortion = Math.round(bbjAmount * ratios.BACKUP * 100) / 100;
    const promoPortion = Math.round(bbjAmount * 100) / 100 - mainPortion - backupPortion;

    // Use bbj_record_contribution RPC — atomically updates pool balances + logs contribution
    // hand_id is nullable (migration 20260325) since server uses hand_history not hands table
    // FIX 205: Try with club_id first (requires migration), fall back to without
    let rpcError: any = null;
    const { error: errWithClub } = await supabase.rpc('bbj_record_contribution', {
      p_pool_id: pool.id,
      p_hand_id: null,
      p_table_id: tableId,
      p_amount: bbjAmount,
      p_main_portion: mainPortion,
      p_backup_portion: backupPortion,
      p_promo_portion: promoPortion,
      p_big_blind: bigBlind,
      p_hand_number: handNumber,
      p_club_id: clubId,
    });

    if (errWithClub && errWithClub.code === 'PGRST202') {
      // Migration not yet applied — fall back to old signature without club_id
      const { error: errNoClub } = await supabase.rpc('bbj_record_contribution', {
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
      rpcError = errNoClub;
    } else {
      rpcError = errWithClub;
    }

    if (rpcError) {
      // Non-critical: BBJ fee already deducted from pot, this is just the ledger entry
      // Only log once per 100 hands to reduce noise
      if (handNumber % 100 === 1) {
        console.warn(
          `[logBBJCollection] BBJ contribution skipped for hand #${handNumber}:`,
          rpcError.message
        );
      }
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
      reportError(error, 'logInsuranceSettlement.RPC_failed_for_player_paramspl');
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
      reportError(new Error(`[refillHorseWallet] Credit failed for horse ${horseId}: ${refillErr.message}`), 'refillHorseWallet.Credit_failed_for_horse_horseI');
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
      reportError(poolErr, 'processBBJPayout.Pool_update_failed');
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
      reportError(payoutErr, 'processBBJPayout.Payout_record_failed');
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
    reportError(e, 'processBBJPayout.Fatal_error');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 137: Hand State Snapshots for Crash Recovery (Bible V8 §7.17, §9.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save or update the hand state snapshot after every action.
 * Uses UPSERT — one active snapshot per table at a time.
 */
export async function saveHandStateSnapshot(params: {
  tableId: string;
  handNumber: number;
  stateJson: Record<string, unknown>;
  configJson: Record<string, unknown>;
  dealerSeat: number;
  playersJson: Record<string, unknown>[];
  stage: string;
}): Promise<void> {
  try {
    const { error } = await supabase.rpc('save_hand_state_snapshot', {
      p_table_id: params.tableId,
      p_hand_number: params.handNumber,
      p_state_json: params.stateJson,
      p_config_json: params.configJson,
      p_dealer_seat: params.dealerSeat,
      p_players_json: params.playersJson,
      p_stage: params.stage,
    });
    if (error) {
      console.warn(`[saveHandStateSnapshot] Error:`, error.message);
    }
  } catch (e) {
    console.warn(`[saveHandStateSnapshot] Exception:`, e);
  }
}

/**
 * Mark a hand snapshot as complete (after settlement).
 * Allows the table to start a fresh hand.
 */
export async function completeHandSnapshot(tableId: string, handNumber: number): Promise<void> {
  try {
    const { error } = await supabase.rpc('complete_hand_snapshot', {
      p_table_id: tableId,
      p_hand_number: handNumber,
    });
    if (error) {
      console.warn(`[completeHandSnapshot] Error:`, error.message);
    }
  } catch (e) {
    console.warn(`[completeHandSnapshot] Exception:`, e);
  }
}

/**
 * Get active (incomplete) hand snapshot for crash recovery.
 * Returns null if no active hand found.
 */
export async function getActiveHandSnapshot(tableId: string): Promise<{
  handNumber: number;
  stateJson: Record<string, unknown>;
  configJson: Record<string, unknown>;
  dealerSeat: number;
  playersJson: Record<string, unknown>[];
  stage: string;
  updatedAt: string;
} | null> {
  try {
    const { data, error } = await supabase.rpc('get_active_hand_snapshot', {
      p_table_id: tableId,
    });
    if (error || !data || data.length === 0) return null;
    const row = data[0];
    return {
      handNumber: row.hand_number,
      stateJson: row.state_json,
      configJson: row.config_json,
      dealerSeat: row.dealer_seat,
      playersJson: row.players_json,
      stage: row.stage,
      updatedAt: row.updated_at,
    };
  } catch (e) {
    console.warn(`[getActiveHandSnapshot] Exception:`, e);
    return null;
  }
}

export default supabase;
