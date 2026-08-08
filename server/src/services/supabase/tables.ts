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
