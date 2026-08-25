/**
 * Supabase helpers — table + seat reads and stack/chip syncing.
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

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
      'id, club_id, small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, rake_percent, rake_cap_bb, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, auto_utg_straddle, voluntary_straddle, run_it_twice_enabled, run_it_twice, allow_run_it_twice, insurance_enabled, auto_muck_enabled, show_hand_enabled, allow_rabbit_hunt, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses, time_bank_enabled, ante_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board, wait_for_big_blind, seven_deuce_enabled, seven_deuce_amount, name, min_buy_in, max_buy_in, bbj_percent, all_in_or_fold, auto_start_players, run_it_mode, is_anonymous, ban_chat, restrict_observers, cap_enabled, cap_bb, pineapple_holdem'
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
    // is_sitting_out added 2026-08-25 for restart fidelity. The engine WRITES
    // this column on every sit-out and sit-back and never read it back, so an
    // engine restart between hands dealt cards to players who had sat out —
    // while the column, and therefore every client, still said they were out.
    .select(
      'user_id, stack, seat_number, time_bank_remaining, time_bank_uses_remaining, is_sitting_out'
    )
    .eq('table_id', tableId)
    .is('left_at', null)
    .order('seat_number', { ascending: true });

  // 2026-08-15: returning [] on ERROR made a transient DB failure
  // indistinguishable from "the table is empty". The engine then assigned []
  // to seatedPlayers, which (a) stopped the synthetic horse heartbeats so every
  // horse went stale and disconnected 30s later, (b) made the table watchdog
  // read the table as idle-by-design so it never tripped, and (c) reported
  // seated_count: 0 to clients. Throwing keeps the engine's last-known-good
  // roster and routes into the dealing loop's transient-error backoff, which
  // already classifies fetch/timeout failures correctly.
  if (error) {
    throw new Error('loadSeatedPlayers failed for ' + tableId + ': ' + error.message);
  }
  if (!seats || seats.length === 0) return [];

  const userIds = seats.map((d) => d.user_id);
  const { data: profiles, error: profileErr } = await supabase
    .from('profiles')
    /* Dan 2026-08-21: the felt shows the CLUB ARENA avatar, never the social
       media photo. `arena_avatar_url` is library art only; `avatar_url` is the
       player's (or horse's) social profile picture and is not ours to read.

       Aliased rather than renamed: the returned key stays `avatar_url`, so the
       engine types, the snapshot mapper and every seat component downstream are
       untouched. Only the source column moves.

       Highest-leverage avatar read in the app - it feeds every seat at every
       table. If it regresses, the felt shows photographs again. */
    .select(
      'id, display_name, username, is_horse, horse_profile, avatar_url:arena_avatar_url, use_real_name'
    )
    .in('id', userIds);
  if (profileErr) {
    // The filter below drops every seat whose profile is missing, so a silent
    // profiles failure emptied the table just as thoroughly as a seats failure.
    throw new Error('loadSeatedPlayers profiles failed for ' + tableId + ': ' + profileErr.message);
  }

  const profileMap = new Map(profiles?.map((p) => [p.id, p]) || []);

  return seats
    .filter((seat) => profileMap.has(seat.user_id))
    .map((seat) => {
      const profile = profileMap.get(seat.user_id)!;
      return {
        user_id: seat.user_id,
        /* Dan 2026-08-18: horses are IDENTITIES, not accounts — their
           `username` is only an internal handle that a DB trigger forces to
           lowercase, so shipping it printed "gatecityethan" / "steven
           ferrara" on the felt. display_name holds the real, properly-cased
           name (half real "First Last", half styled poker alias), so horses
           always resolve through it. Humans keep the use_real_name
           preference exactly as before. */
        username: profile.is_horse
          ? profile.display_name || profile.username || 'Player'
          : profile.use_real_name
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
        is_sitting_out: seat.is_sitting_out === true,
        avatar_url: profile.avatar_url || '',
      };
    });
}

/**
 * Sync player stacks back to database after a hand
 */
export async function syncStacks(
  tableId: string,
  players: {
    user_id: string;
    stack: number;
    time_bank_uses_remaining?: number;
    time_bank_remaining?: number;
  }[]
): Promise<void> {
  // Dan 2026-08-25, BINDING: "ALL CHIPS ON ALL TABLES MUST STAY EXACTLY THE
  // SAME" across an engine restart. This function is the ONLY place a hand's
  // result reaches durable storage, and it had two ways to lose chips silently.
  //
  // 1. IT COULD NOT SEE MOST FAILURES. `Promise.allSettled` only reports
  //    `rejected`, and the supabase client does not REJECT on a database
  //    error — it RESOLVES with `{ error }`. So an RLS refusal, a constraint
  //    violation or a stale-seat mismatch counted as a success, and the
  //    "n/m stack syncs failed" alarm could only ever fire on a network throw.
  // 2. THERE WAS NO RETRY. One write per player, best effort. If the winner's
  //    landed and a loser's did not, the table gained chips; the reverse
  //    destroyed them. A restart straight after made the in-memory truth —
  //    the only correct copy — unrecoverable.
  //
  // Each seat is now retried independently, and a seat that still will not
  // write is reported by user id rather than as a count.
  const writeSeat = async (player: (typeof players)[number]): Promise<string | null> => {
    // FIX-231d: Round to 2 decimal places to prevent float-point drift (e.g. 5799.700000000001)
    const updatePayload: Record<string, unknown> = {
      stack: Math.round(player.stack * 100) / 100,
    };
    if (player.time_bank_uses_remaining !== undefined) {
      updatePayload.time_bank_uses_remaining = player.time_bank_uses_remaining;
    }
    if (player.time_bank_remaining !== undefined) {
      updatePayload.time_bank_remaining = player.time_bank_remaining;
    }

    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { error } = await supabase
          .from('table_seats')
          .update(updatePayload)
          .eq('table_id', tableId)
          .eq('user_id', player.user_id)
          .is('left_at', null);
        if (!error) return null;
        lastError = error.message ?? String(error);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      // Short, bounded backoff. Settlement is already past the point where the
      // hand can be undone, so this must finish rather than run forever.
      if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
    }
    return `${player.user_id}: ${lastError}`;
  };

  const failures = (await Promise.all(players.map(writeSeat))).filter(
    (f): f is string => f !== null
  );

  if (failures.length > 0) {
    // Chips are now provably wrong for these seats, and the correct value only
    // exists in a process that may be about to exit. Name the seats.
    reportError(
      new Error(
        `[DB] ${failures.length}/${players.length} stack syncs failed for table ${tableId} ` +
          `after 3 attempts each — ${failures.join('; ')}`
      ),
      'DB.sync_stacks_failed'
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

  // ONE bulk statement, not one UPDATE per seat.
  //
  // This function was the last surviving caller of the N+1 that
  // TournamentManagerEliminations.ts:30-63 already replaced with
  // fn_sync_tournament_chips. Measured on production 2026-08-25 it was still
  // issuing 27,206 single-row PostgREST UPDATEs - a 9-handed table cost nine
  // separate round trips every settlement - and tournament_players is in the
  // supabase_realtime publication, so every one of those also paid a logical
  // decode plus an RLS evaluation per subscriber. tournament_players was 48%
  // of all writes to published tables while realtime decoding was the single
  // largest consumer of database time.
  //
  // The RPC additionally skips rows whose chip count is already correct
  // (migration 20260825_perf_sync_tournament_chips_skip_noop_writes), which a
  // per-row UPDATE could never do, and scopes the write to status='playing' so
  // an already-eliminated player's final stack cannot be overwritten.
  const chipUpdates = seats.map((seat) => ({
    user_id: seat.user_id,
    // Guard against corrupted stack values (NaN, negative, undefined), matching
    // the guard in TournamentManagerEliminations.
    // Math.floor — tournament_players.chips is INTEGER. An earlier version
    // computed 2-decimal cents (e.g. 80511.97) which Postgres rejected at
    // PostgREST cast time, flooding postgres logs with thousands of
    // "invalid input syntax for type integer" errors per minute.
    // Verified in Smarter-Poker-World-Hub/.agent/POSTGRES_INTEGER_CAST_FLOOD.md
    chips: Math.floor(
      typeof seat.stack === 'number' && !isNaN(seat.stack) && seat.stack >= 0 ? seat.stack : 0
    ),
  }));

  const { error } = await supabase.rpc('fn_sync_tournament_chips', {
    p_tournament_id: tournamentId,
    p_updates: chipUpdates,
  });
  if (error) reportError(error, 'supabase.syncTournamentChips');
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
