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
  reportError(
    new Error('[Supabase] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set!'),
    'Supabase.FATAL'
  );
  // Under the test runner the service-role key is intentionally absent (handlers
  // are exercised with mocked Supabase); exiting the process aborts the whole
  // suite. Only hard-exit in a real runtime.
  if (!process.env.VITEST) {
    process.exit(1);
  }
}

// createClient throws if the key is falsy; supply a harmless placeholder under
// the test runner so module import doesn't blow up before mocks are applied.
const EFFECTIVE_SERVICE_ROLE_KEY =
  SUPABASE_SERVICE_ROLE_KEY || (process.env.VITEST ? 'test-placeholder-key' : '');

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE ROLE CLIENT — Full DB access, bypasses RLS
// ═══════════════════════════════════════════════════════════════════════════════

export const supabase: SupabaseClient = createClient(SUPABASE_URL, EFFECTIVE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// REALTIME BROADCASTING — Push hand state to all connected clients
// ═══════════════════════════════════════════════════════════════════════════════

// Channel cache to avoid creating new channels for every broadcast
// Phase 1.1 PR-5 (NO-GO-2): broadcastHandState + channelCache + cleanup*
// deleted. The Supabase Realtime `hand-state:{tableId}` channel is no longer
// the game-state transport — engine WebSocket at /ws/table/:tableId is the
// sole path, served by TableStateHub in server/src/transport/.

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
      // RAKE-AUDIT 2026-07-24: bbj_percent added — the FIX-A2 BBJ gate reads
      // tableInfo.bbj_percent, but this select never fetched it, so the gate
      // saw `undefined ?? 0` and disabled the BBJ fee on every table.
      'id, club_id, small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, time_bank_seconds, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, auto_utg_straddle, voluntary_straddle, run_it_twice_enabled, insurance_enabled, auto_muck_enabled, show_hand_enabled, allow_rabbit_hunt, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses, time_bank_enabled, ante_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, wait_for_big_blind, seven_deuce_enabled, seven_deuce_amount, name, min_buy_in, max_buy_in, bbj_percent'
    )
    .eq('id', tableId)
    .maybeSingle();

  if (error) {
    const msg = error.message || (error as any).details || JSON.stringify(error);
    throw new Error(`Failed to load table ${tableId}: ${msg}`);
  }
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
          ? profile.display_name || profile.username || 'Player'
          : profile.username || profile.display_name || 'Player',
        stack: seat.stack,
        seat_number: seat.seat_number || 1,
        is_horse: profile.is_horse || false,
        // AUDIT V2 (2026-07-23): pass the raw jsonb value through — it can be a
        // string OR an object ({"style":"tag",...}). resolveHorseStyle() in
        // HorseLogic handles both plus a deterministic per-horse fallback.
        horse_profile: profile.horse_profile ?? undefined,
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
      // FIX-231d: Round to 2 decimal places to prevent float-point drift (e.g. 5799.700000000001)
      const updatePayload: any = { stack: Math.round(player.stack * 100) / 100 };
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
    reportError(
      new Error(
        `[DB] ${failures.length}/${players.length} stack syncs failed for table ${tableId}`
      ),
      'DB.failureslengthplayerslength_st'
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
      // Math.floor — tournament_players.chips is INTEGER. Previous version
      // computed 2-decimal cents (e.g. 80511.97) which Postgres rejected at
      // PostgREST cast time, flooding postgres logs with thousands of
      // "invalid input syntax for type integer" errors per minute.
      // Verified in Smarter-Poker-World-Hub/.agent/POSTGRES_INTEGER_CAST_FLOOD.md
      const exact = Math.floor(seat.stack);
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
 * Auto-rebuy a horse from their Player Wallet atomically.
 * ROUND 34 FIX: Direct UPDATE on public.wallets is rejected by the
 * Phase 4.1.6a wallet guard. All balance changes must flow through
 * whitelisted SECURITY DEFINER RPCs that log to chip_ledger. Replaced
 * the manual 4-step sequence (select + update wallet + update seat +
 * insert audit row) with the atomic_table_rebuy RPC, which performs
 * all 4 atomically and is whitelisted.
 *
 * Caller signature kept stable; clubId is passed but not consumed —
 * the RPC resolves it from tables(id) transitively.
 */
export async function autoRebuyHorse(
  tableId: string,
  userId: string,
  rebuyAmount: number,
  clubId: string
): Promise<boolean> {
  void clubId;
  try {
    // Fund the horse rebuy from the TABLE's club treasury (fn_horse_fund_from
    // _treasury derives the club from the table). Horses no longer draw on a
    // globally-minted wallet — the chips come from the club's real bankroll and
    // the rebuy fails cleanly if the treasury is short (the horse busts, correct
    // conservation behavior). Real-player rebuys still use atomic_table_rebuy.
    const { data, error } = await supabase.rpc('fn_horse_fund_from_treasury', {
      p_table_id: tableId,
      p_user_id: userId,
      p_amount: rebuyAmount,
    });

    if (error || !data?.success) {
      const msg = error?.message || data?.error || '';
      if (!msg.includes('insufficient') && !msg.includes('no active seat')) {
        reportError(
          new Error(msg || 'horse treasury rebuy failed'),
          'DB.horse_treasury_rebuy_failed'
        );
      }
      return false;
    }

    return true;
  } catch (err: any) {
    reportError(err, 'DB.Unexpected_horse_treasury_rebuy');
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
      .select('id, stack')
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

    // 2. Credit wallet if stack > 0 — atomically (balance += stack AND the audit
    //    log row in one transaction). The old read-then-upsert lost chips under
    //    concurrent credits (e.g. leaving two tables at once, or a simultaneous
    //    buy-in on the same wallet). If the credit fails we do NOT vacate the
    //    seat below, so the player's stack is never destroyed — a retry re-runs
    //    the leave and re-attempts the credit.
    if (stack > 0) {
      const { error: creditErr } = await supabase.rpc('atomic_credit_wallet_and_log', {
        p_user_id: userId,
        p_amount: stack,
        p_category: 'cashout',
        p_description: 'Cash-out from table',
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
        // P1-2 FIX: idempotency key keyed on the seat-occupancy row id, IDENTICAL
        // to the atomicCashout fix (`cashout:<seat.id>`), so a committed-but-
        // timed-out credit here is a DB-side no-op on retry (no double-credit),
        // and a seat cashed out by either path dedupes against the other.
        p_idempotency_key: `cashout:${seat.id}`,
      });
      if (creditErr) {
        console.error(
          `[markSeatAsLeft] cash-out credit failed for ${userId} — leaving seat occupied to avoid chip loss:`,
          creditErr.message
        );
        return;
      }
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
  // SWEEP #4 P0-3: track whether it is SAFE to soft-delete the seat in the
  // catch fallback. It is only safe once the wallet credit succeeded (or there
  // was nothing to credit). If we throw before that, deleting the seat would
  // destroy the stack, so the fallback must preserve it instead.
  let safeToClearSeat = false;
  try {
    // 1. Find active seat
    let query = supabase
      .from('table_seats')
      .select('id, stack, seat_number')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    if (seatNumber !== undefined) {
      query = query.eq('seat_number', seatNumber);
    }

    const { data: seat } = await query.maybeSingle();
    if (!seat) return 0;

    const stack = seat.stack ?? 0;
    if (stack <= 0) safeToClearSeat = true; // nothing at risk if there is no stack

    // 2. Credit wallet — FIX-232: Atomic increment via RPC (eliminates race condition)
    // SWEEP #4 P0-3 FIX (2026-07-23): the credit error was only logged, then the
    // seat was soft-deleted UNCONDITIONALLY below — so a transient 502/timeout on
    // credit_player_wallet destroyed the player's entire stack (seat gone, wallet
    // not credited, unrecoverable). Sibling markSeatAsLeft already returns early
    // on credit failure "to avoid chip loss"; mirror that here. On failure we
    // preserve the seat (left_at stays null) so the cashout is retried next pass.
    if (stack > 0) {
      const { error: walletErr } = await supabase.rpc('credit_player_wallet', {
        p_user_id: userId,
        p_amount: stack,
        // A3 FIX (2026-07-29): this path is explicitly retryable (on credit
        // failure the seat is preserved and re-cashed next pass), so a
        // committed-but-timed-out credit would double-pay the stack on retry.
        // Keyed on the seat-occupancy row id in the SAME `cashout:<seat.id>`
        // format markSeatAsLeft uses — both RPCs share wallet_credit_idempotency,
        // so a seat cashed out by either path dedupes against the other.
        p_idempotency_key: `cashout:${seat.id}`,
      });
      if (walletErr) {
        console.warn(
          `[atomicCashout] Wallet credit failed for ${userId} — preserving seat for retry:`,
          walletErr.message
        );
        return 0; // do NOT soft-delete; stack stays on the seat, retryable
      }
      safeToClearSeat = true; // credit committed — safe to clear the seat now

      // BUG 018 FIX: read new balance for balance_after audit field
      const { data: postWallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', userId)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();

      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        wallet_type: 'PLAYER',
        type: 'credit',
        amount: stack,
        category: 'cashout',
        description: 'Cash-out from table',
        table_id: tableId,
        balance_after: postWallet?.balance ?? null,
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

    // TOURNEY-AUDIT 2026-07-24 (sweep 6): seat opened — notify the waitlist.
    void notifyWaitlistSeatOpen(tableId);

    return stack;
  } catch (err: any) {
    // SWEEP #4 P0-3 FIX: only soft-delete on exception if the credit already
    // committed (or there was no stack). Otherwise preserve the seat so the
    // stack is not destroyed on a transient failure — it will be retried.
    if (safeToClearSeat) {
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .is('left_at', null);
    } else {
      console.warn(
        `[atomicCashout] Exception before credit committed for ${userId} — preserving seat:`,
        err?.message
      );
    }
    return 0;
  }
}

/**
 * TOURNEY-AUDIT 2026-07-24 (sweep 6): cash-game waitlist notifier. When a seat
 * opens at a cash table, the longest-waiting 'waiting' entry is flipped to
 * 'notified' and receives a notification row — the player then sits via the
 * normal buy-in flow. Cash games only (tournament entrants are auto-seated by
 * the engine, never queued). Fire-and-forget; failures never block the table.
 */
export async function notifyWaitlistSeatOpen(tableId: string): Promise<void> {
  try {
    // Only cash tables have waitlists
    const { data: tableRow } = await supabase
      .from('tables')
      .select('id, name, tournament_id, max_players, current_players')
      .eq('id', tableId)
      .maybeSingle();
    if (!tableRow || tableRow.tournament_id) return;
    if ((tableRow.current_players ?? 0) >= (tableRow.max_players ?? 9)) return;

    const { data: next } = await supabase
      .from('table_waitlists')
      .select('id, user_id')
      .eq('table_id', tableId)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!next) return;

    const { data: claimed } = await supabase
      .from('table_waitlists')
      .update({ status: 'notified', notified_at: new Date().toISOString() })
      .eq('id', next.id)
      .eq('status', 'waiting')
      .select('id');
    if (!claimed || claimed.length === 0) return; // raced — another opener claimed it

    await supabase.from('notifications').insert({
      user_id: next.user_id,
      type: 'waitlist_seat_open',
      title: 'Seat open!',
      message: `A seat just opened at ${tableRow.name || 'your waitlisted table'} — sit down now to claim it.`,
      data: { table_id: tableId },
    });
    console.log(
      `[Waitlist] Notified ${next.user_id.slice(0, 8)} — seat open at ${tableId.slice(0, 8)}`
    );
  } catch (e) {
    console.warn(`[Waitlist] notify failed for table ${tableId}:`, e);
  }
}

/**
 * Process leave-pending players after hand completion
 */
export async function processLeavePending(tableId: string, clubId: string): Promise<string[]> {
  const { data: pendingSeats } = await supabase
    .from('table_seats')
    .select('user_id, stack, seat_number')
    .eq('table_id', tableId)
    .eq('leave_pending', true)
    .is('left_at', null);

  if (!pendingSeats || pendingSeats.length === 0) return [];

  const cashedOut: string[] = [];
  for (const seat of pendingSeats) {
    // FIX 208: Use direct atomicCashout instead of RPC
    await atomicCashout(seat.user_id, tableId, seat.seat_number);
    cashedOut.push(seat.user_id);
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

  // TOURNEY-AUDIT 2026-07-24 (sweep 6): a seat opened — offer it to the
  // longest-waiting waitlisted player (cash tables only; no-op otherwise).
  if (cashedOut.length > 0) {
    void notifyWaitlistSeatOpen(tableId);
  }

  // Round 57: callers use this list to unregister disconnect tracking for
  // players who cashed out. Without this, DisconnectEngine.playerStates leaks.
  return cashedOut;
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
  potAmount: number,
  // Round 42 fix: BBJ amount threaded through so club_wallets.period_bbj_contribution
  // gets credited and chip_balance reflects the correct net (rake - bbj). Default
  // 0 keeps backwards-compat for any caller that doesn't pass it yet.
  bbjAmount: number = 0,
  // Round 43 fix: hand_history.id (UUID) for FK linking the
  // club_wallet_transactions audit row back to the originating hand.
  handId: string | null = null
): Promise<void> {
  if (rakeAmount <= 0) return;

  // Phase J: rake_history was a write-only legacy table. Verified no readers
  // anywhere in the codebase (engine, workers, World Hub, frontend). The
  // canonical hand-level rake ledger is rake_records (settler input + R73
  // hand_id linkage). rake_history had grown to 1.37M rows / ~295 MB at
  // ~1,128 rows/day with zero queriers. Insert removed — table will be
  // dropped in a follow-up cleanup migration.

  // Credit rake to the correct entity wallet:
  // - Club NOT in a union → credit to CLUB wallet (clubs.chip_pool)
  // - Club IN a union → credit to UNION wallet (union_wallets.rake_wallet)
  // NEVER goes to a player's personal wallet.
  //
  // Round 42 fix: ALWAYS update club_wallets accumulators (period + lifetime
  // rake/BBJ counters + audit transaction row) regardless of standalone vs
  // union, because club_wallets is the canonical audit / dashboard counter.
  // Pre-fix, club_wallets stayed at zero for every active club (verified
  // live: Shark Club had $5,020 of 24h rake but club_wallets read $0).
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

    // Round 42: update club_wallets accumulators + audit ledger BEFORE the
    // entity-specific credit (union or chip_pool). Independent of where the
    // chips actually settle — this is the rake-collected counter.
    {
      const { error: cwErr } = await supabase.rpc('credit_club_wallet_rake', {
        p_club_id: clubId,
        p_rake: rakeAmount,
        p_bbj: bbjAmount,
        p_hand_id: handId,
        p_hand_number: handNumber,
      });
      if (cwErr) {
        reportError(
          new Error(`[logRakeCollection] club_wallets credit failed: ${cwErr.message}`),
          'logRakeCollection.club_wallets_credit_failed'
        );
      }
    }

    if (club.union_id) {
      // Club is in a union — ALL rake held by union wallet until weekly settlement
      // FIX-232: Atomic increment via RPC — eliminates read-then-write race condition
      const { error: uwErr } = await supabase.rpc('increment_union_wallet', {
        p_union_id: club.union_id,
        p_amount: rakeAmount,
      });
      if (uwErr) {
        reportError(
          new Error(`[logRakeCollection] Union wallet credit failed: ${uwErr.message}`),
          'logRakeCollection.Union_wallet_credit_failed'
        );
      }

      // Log union transaction for audit trail (BUG 013 FIX — was union_transactions, that
      // table doesn't exist; actual audit table is union_wallet_transactions with required
      // fields amount + wallet + direction + tx_type + balance_after).
      // ROUND 16 FIX: wallet must be one of {chip_balance, rake_wallet, bbj_wallet,
      // promo_wallet} per union_wallet_transactions_wallet_check; 'main' was rejected
      // by the CHECK constraint, silently dropping every union rake audit row. Rake
      // collection credits the rake_wallet sub-account.
      {
        const { data: wallet } = await supabase
          .from('union_wallets')
          .select('rake_wallet')
          .eq('union_id', club.union_id)
          .maybeSingle();
        await supabase.from('union_wallet_transactions').insert({
          union_id: club.union_id,
          club_id: clubId,
          amount: rakeAmount,
          tx_type: 'rake',
          wallet: 'rake_wallet',
          direction: 'credit',
          balance_after: wallet?.rake_wallet ?? null,
          notes: `Cash game rake: hand #${handNumber} (${club.name || 'club'})`,
        });
      }
    } else {
      // Standalone club — the rake chips settle into the club's OPERATIONAL BANK,
      // clubs.chip_treasury. NOTE the naming trap: increment_club_chip_pool writes
      // chip_treasury (+ total_rake), NOT chip_pool (chip_pool is the separate
      // mint-and-distribute ledger). The club_wallets accounting counter was already
      // credited above (credit_club_wallet_rake) for every club regardless of where
      // the chips settle. See .agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md.
      const { error: cpErr } = await supabase.rpc('increment_club_chip_pool', {
        p_club_id: clubId,
        p_amount: rakeAmount,
      });
      if (cpErr) {
        reportError(
          new Error(`[logRakeCollection] Club chip_pool credit failed: ${cpErr.message}`),
          'logRakeCollection.Club_chip_pool_credit_failed'
        );
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
// IMPROVE 2026-07-21: per-hand BBJ collection used to run TWO extra queries
// per raked hand (clubs.union_id + the pool lookup). Cache the resolved pool
// id per club with a 5-minute TTL — pool membership changes are rare (a club
// joining/leaving a union), and the TTL bounds the staleness window. The
// pivot check still reads the LIVE main_balance via the cached pool id.
const bbjPoolCache = new Map<string, { poolId: string; expiresAt: number }>();
const BBJ_POOL_CACHE_TTL_MS = 5 * 60 * 1000;

export async function logBBJCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  bbjAmount: number,
  bigBlind: number,
  // Round 44 fix: hand_history.id (UUID) for FK linking the bbj_contributions
  // audit row back to the originating hand. Default null preserves caller compat.
  handId: string | null = null
): Promise<void> {
  if (bbjAmount <= 0) return;

  // FIX 140: Pivot-based allocation thresholds (Bible V8 §4.13)
  const BBJ_PIVOT_THRESHOLD = 100000; // 100,000 chips
  const BBJ_ALLOCATION = {
    STANDARD: { MAIN: 0.5, BACKUP: 0.25, PROMO: 0.25 },
    PIVOT: { MAIN: 0.3, BACKUP: 0.4, PROMO: 0.3 },
  };

  try {
    let pool: { id: string; main_balance: number | null } | null = null;

    const cached = bbjPoolCache.get(clubId);
    if (cached && cached.expiresAt > Date.now()) {
      // Cached pool id — one query for the live balance (pivot check).
      const { data: cachedPool } = await supabase
        .from('bbj_pools')
        .select('id, main_balance')
        .eq('id', cached.poolId)
        .maybeSingle();
      pool = cachedPool;
      if (!pool) bbjPoolCache.delete(clubId); // pool vanished — fall through
    }

    if (!pool) {
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
      const { data: freshPool } = await poolQuery.maybeSingle();
      pool = freshPool;
      if (pool) {
        bbjPoolCache.set(clubId, {
          poolId: pool.id,
          expiresAt: Date.now() + BBJ_POOL_CACHE_TTL_MS,
        });
      }
    }

    if (!pool) {
      // RAKE-AUDIT 2026-07-24: AUTO-CREATE the pool instead of skipping. The
      // old "no pool → skip" path meant the BBJ fee had already been deducted
      // from the pot but was banked NOWHERE — silent money destruction for any
      // club (or union) whose bbj_pools row was never seeded. Service-role
      // client bypasses RLS, so this insert is safe server-side only.
      const { data: clubRow } = await supabase
        .from('clubs')
        .select('union_id')
        .eq('id', clubId)
        .maybeSingle();
      const insertPayload = clubRow?.union_id
        ? { union_id: clubRow.union_id, main_balance: 0, backup_balance: 0, promo_balance: 0 }
        : { club_id: clubId, main_balance: 0, backup_balance: 0, promo_balance: 0 };
      const { data: newPool, error: createErr } = await supabase
        .from('bbj_pools')
        .insert(insertPayload)
        .select('id, main_balance')
        .maybeSingle();
      if (createErr || !newPool) {
        reportError(
          new Error(
            `[logBBJCollection] BBJ pool auto-create FAILED for club ${clubId} — fee of ${bbjAmount} collected but not banked: ${createErr?.message}`
          ),
          'logBBJCollection.pool_autocreate_failed'
        );
        return;
      }
      console.log(
        `[logBBJCollection] Auto-created BBJ pool ${newPool.id} for ${clubRow?.union_id ? `union ${clubRow.union_id}` : `club ${clubId}`}`
      );
      pool = newPool;
      bbjPoolCache.set(clubId, {
        poolId: newPool.id,
        expiresAt: Date.now() + BBJ_POOL_CACHE_TTL_MS,
      });
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
      p_hand_id: handId,
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
        p_hand_id: handId,
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
/**
 * Bible V8 §2.18: 4-tier Hand History system
 *
 * Tier 1: raw_events — Every action with timestamps (audit/dispute)
 * Tier 2: audit_log — Normalized format for compliance review
 * Tier 3: player_summary — Per-player view (what they can see in their history)
 * Tier 4: dispute_review — Full data package for dispute resolution
 *
 * All 4 tiers are computed from the same input and stored in a single row
 * with JSONB columns for each tier.
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
  // Round 38 — wall-clock timestamps. startedAt is captured at HAND_START
  // in ServerTableEngine; endedAt is stamped here at write time.
  startedAt?: number;
  endedAt?: number;
  winners: {
    userId: string;
    amount: number;
    potIndex?: number;
    hand?: { name: string; ranking: number };
  }[];
  players: { userId: string; username: string; seat: number; stack: number; cards: string[] }[];
  actions: {
    seat: number;
    userId?: string;
    action: string;
    amount?: number;
    timestamp?: number;
    stage: string;
  }[];
  showdownResults?: {
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards: { rank: string; suit: string }[];
  }[];
}): Promise<{ handId: string | null }> {
  // ── Tier 1: Raw Events ──────────────────────────────────────────────
  const rawEvents = params.actions.map((a, idx) => ({
    seq: idx,
    seat: a.seat,
    userId: a.userId || params.players.find((p) => p.seat === a.seat)?.userId || 'unknown',
    action: a.action,
    amount: a.amount ?? 0,
    stage: a.stage,
    timestamp: a.timestamp ?? Date.now(),
  }));

  // ── Tier 2: Audit Log ───────────────────────────────────────────────
  const auditLog = {
    table_id: params.tableId,
    tournament_id: params.tournamentId || null,
    hand_number: params.handNumber,
    game_variant: params.gameVariant,
    blinds: { sb: params.smallBlind, bb: params.bigBlind },
    pot_size: params.potSize,
    rake: params.rakeAmount,
    bbj_fee: params.bbjAmount || 0,
    board: params.communityCards,
    player_count: params.players.length,
    action_count: params.actions.length,
    went_to_showdown: (params.showdownResults?.length ?? 0) > 0,
    created_at: new Date().toISOString(),
  };

  // ── Tier 3: Player Summaries ────────────────────────────────────────
  const playerSummaries = params.players.map((p) => {
    const winRecord = params.winners.find((w) => w.userId === p.userId);
    const showdown = params.showdownResults?.find((s) => s.userId === p.userId);
    const playerActions = params.actions.filter((a) => a.seat === p.seat || a.userId === p.userId);
    return {
      userId: p.userId,
      username: p.username,
      seat: p.seat,
      startStack: p.stack,
      netResult: winRecord ? winRecord.amount : 0,
      handName: showdown?.handName || null,
      handRanking: showdown?.handRanking || null,
      actionCount: playerActions.length,
      folded: playerActions.some((a) => a.action === 'fold'),
      wentAllIn: playerActions.some((a) => a.action === 'all_in'),
    };
  });

  // ── Tier 4: Dispute Review Package ──────────────────────────────────
  const disputeReview = {
    raw_events: rawEvents,
    audit_log: auditLog,
    player_summaries: playerSummaries,
    showdown_results: params.showdownResults || [],
    community_cards: params.communityCards,
    pot_breakdown: params.winners,
    integrity_hash: `${params.tableId}:${params.handNumber}:${Date.now()}`,
  };

  // Round 38 fix: stamp started_at/ended_at + RETURNING id so the caller
  // can FK rake_records.hand_id back to this hand_history row.
  const startedAtIso = params.startedAt
    ? new Date(params.startedAt).toISOString()
    : new Date().toISOString();
  const endedAtIso = params.endedAt
    ? new Date(params.endedAt).toISOString()
    : new Date().toISOString();

  const { data, error } = await supabase
    .from('hand_history')
    .insert({
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
      started_at: startedAtIso,
      ended_at: endedAtIso,
      winners: params.winners,
      players: params.players,
      actions: params.actions,
      // Bible V8 §2.18: 4-tier hand history layers (stored as JSONB)
      raw_events: rawEvents,
      audit_log: auditLog,
      player_summaries: playerSummaries,
      dispute_review: disputeReview,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    // Non-fatal: the 4-tier columns may not exist yet in the DB schema.
    // Fall back to legacy insert without the new columns if the error is about unknown columns.
    if (error.message?.includes('column') || error.code === '42703') {
      const { data: fbData, error: fallbackError } = await supabase
        .from('hand_history')
        .insert({
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
          started_at: startedAtIso,
          ended_at: endedAtIso,
          winners: params.winners,
          players: params.players,
          actions: params.actions,
        })
        .select('id')
        .maybeSingle();
      if (fallbackError) {
        console.warn(
          `[DB] Failed to log hand history #${params.handNumber}:`,
          fallbackError.message
        );
        return { handId: null };
      }
      return { handId: fbData?.id ?? null };
    }
    console.warn(`[DB] Failed to log hand history #${params.handNumber}:`, error.message);
    return { handId: null };
  }
  return { handId: data?.id ?? null };
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
      reportError(
        new Error(`[refillHorseWallet] Credit failed for horse ${horseId}: ${refillErr.message}`),
        'refillHorseWallet.Credit_failed_for_horse_horseI'
      );
      return;
    }

    // BUG 018 FIX: compute balance_after from the known prior balance + topup
    const newBalance = Number(wallet.balance ?? 0) + topUp;
    const { error: refillTxErr } = await supabase.from('wallet_transactions').insert({
      user_id: horseId,
      wallet_type: 'PLAYER',
      amount: topUp,
      type: 'credit',
      category: 'horse_refill',
      description: `Horse wallet refill: ${topUp} chips (balance was ${wallet.balance})`,
      balance_after: newBalance,
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
  seatedUserIds: string[]; // currently-seated user_ids (engine memory) — decides seat-credit vs direct wallet-credit for departed recipients
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

    // 3-5. FIX-A4 2026-07-19: atomic + idempotent payout via RPC. The RPC locks
    // the pool row, computes the payout from the LOCKED balance (no stale-read
    // mint), claims the hand via a unique (pool,table,hand) key before
    // decrementing, and records bbj_payouts — all in one transaction. Replaces
    // the previous non-atomic read-modify-write that could double-pay on
    // simultaneous hits or a task retry.
    const { data: rpcRows, error: rpcErr } = await supabase.rpc('bbj_atomic_payout_v2', {
      p_pool_id: pool.id,
      p_table_id: params.tableId,
      p_hand_number: params.handNumber,
      p_payout_total_percent: params.payoutTotalPercent,
      p_loser_user_id: params.loserUserId, // BBJ "winner" (bad-beat holder, 50%)
      p_winner_user_id: params.winnerUserId, // BBJ "loser" (hand winner, 25%)
      // FIX P0-2 (2026-07-24): v2 credits recipients INSIDE the payout txn —
      // seated players (present in p_seated_ids) get table_seats.stack += share,
      // departed players get their wallet credited directly. The debit and every
      // credit are one atomic unit, so a crash can no longer debit the pool while
      // paying nobody, and a departed winner's share is never dropped.
      p_dealt_in_ids: params.dealtInPlayerIds,
      p_seated_ids: params.seatedUserIds,
      p_metadata: {
        winner_hand_name: params.loserHandName,
        loser_hand_name: params.winnerHandName,
        status: 'completed',
      },
    });

    if (rpcErr) {
      reportError(rpcErr, 'processBBJPayout.Atomic_rpc_failed');
      return null;
    }

    const rpc = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    if (!rpc || !rpc.applied) {
      // already_paid (retry / concurrent / restart) or empty/zero pool. v2 has
      // already RE-DRIVEN any missing recipient credit inside the RPC (money is
      // durably placed — seats + wallets), so there is nothing left for the
      // engine to credit. Returning null here is now SAFE (no chip loss); it
      // used to mean permanent loss under the old non-recoverable payout.
      if (rpc?.already_paid) {
        console.warn(
          `[processBBJPayout] Already paid — hand ${params.tableId}#${params.handNumber} on pool ${pool.id}` +
            (rpc?.recovered ? ' (re-drove a missing recipient credit)' : '')
        );
      }
      return null;
    }

    const totalPayout = Number(rpc.total_payout);
    const loserShare = Number(rpc.loser_share);
    const winnerShare = Number(rpc.winner_share);
    const tableShareTotal = Number(rpc.table_share);

    // Table-only players (for the log/broadcast only). v2 already credited every
    // recipient atomically and returns the exact per-player share it applied.
    const tableOnlyPlayers = params.dealtInPlayerIds.filter(
      (id) => id !== params.loserUserId && id !== params.winnerUserId
    );
    const perPlayerShare = Number(rpc.per_player_share);

    // NOTE (FIX P0-2): bbj_atomic_payout_v2 already records every recipient in
    // bbj_payout_recipients (idempotently, via the (payout_id,user_id) claim key)
    // AND inserts the bbj_winners "Previous Winners" row inside the same atomic
    // transaction as the debit + credits. The former app-side inserts here were
    // removed — the recipient insert would now violate the new unique claim key,
    // and the bbj_winners insert would create a duplicate row.

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

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1.2 PR-D: persistence of pending deadlines + disconnect FSM states.
// The columns live on the SAME row as the active hand snapshot (keyed by
// table_id + hand_number). They're optional — the legacy save/load path still
// works; these helpers write and read the two new jsonb columns directly.
// ═══════════════════════════════════════════════════════════════════════════════

export interface PendingDeadline {
  eventId: string;
  deadlineMs: number;
}

export type DisconnectFsmState = 'CONNECTED' | 'MISSING' | 'DISCONNECTED' | 'SAT_OUT';

export interface DisconnectStateEntry {
  state: DisconnectFsmState;
  sinceMs: number;
  graceDeadlineMs: number | null;
}

/**
 * Save pending deadlines + disconnect states onto the active (incomplete)
 * snapshot row for a table. Called by ServerTableEngine on each
 * broadcastCurrentState so the latest deadlines live in the DB.
 * A no-op + warning if no active snapshot exists yet.
 */
export async function saveHandSnapshotExtras(params: {
  tableId: string;
  handNumber: number;
  pendingDeadlines: PendingDeadline[];
  disconnectStates: Record<string, DisconnectStateEntry>;
}): Promise<void> {
  try {
    const { error } = await supabase
      .from('hand_state_snapshots')
      .update({
        pending_deadlines: params.pendingDeadlines,
        disconnect_states: params.disconnectStates,
        updated_at: new Date().toISOString(),
      })
      .eq('table_id', params.tableId)
      .eq('hand_number', params.handNumber)
      .eq('is_complete', false);
    if (error) {
      console.warn(`[saveHandSnapshotExtras] Error:`, error.message);
    }
  } catch (e) {
    console.warn(`[saveHandSnapshotExtras] Exception:`, e);
  }
}

/**
 * Get the active snapshot with pending_deadlines + disconnect_states.
 * Used by ServerTableEngine.start() to rehydrate the deadline scheduler
 * and disconnect FSM after a crash or restart. Returns null if no active
 * hand snapshot exists.
 */
export async function getActiveHandSnapshotFull(tableId: string): Promise<{
  handNumber: number;
  stateJson: Record<string, unknown>;
  configJson: Record<string, unknown>;
  dealerSeat: number;
  playersJson: Record<string, unknown>[];
  stage: string;
  updatedAt: string;
  pendingDeadlines: PendingDeadline[];
  disconnectStates: Record<string, DisconnectStateEntry>;
} | null> {
  try {
    const { data, error } = await supabase
      .from('hand_state_snapshots')
      .select(
        'hand_number, state_json, config_json, dealer_seat, players_json, stage, updated_at, pending_deadlines, disconnect_states'
      )
      .eq('table_id', tableId)
      .eq('is_complete', false)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      handNumber: data.hand_number,
      stateJson: data.state_json,
      configJson: data.config_json,
      dealerSeat: data.dealer_seat,
      playersJson: data.players_json,
      stage: data.stage,
      updatedAt: data.updated_at,
      pendingDeadlines: (data.pending_deadlines as PendingDeadline[]) ?? [],
      disconnectStates: (data.disconnect_states as Record<string, DisconnectStateEntry>) ?? {},
    };
  } catch (e) {
    console.warn(`[getActiveHandSnapshotFull] Exception:`, e);
    return null;
  }
}

export default supabase;
