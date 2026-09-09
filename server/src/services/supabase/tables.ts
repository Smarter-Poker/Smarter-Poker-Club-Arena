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
import { parseTableArenaIdentity, assertChipFundingArena } from '../../domain/ArenaContext.js';
import { reportError } from '../errorReporter.js';
import { SEATED_PROFILE_SELECT } from './tableAvatar.js';

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
      'id, club_id, union_id, arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id), small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, rake_percent, rake_cap_bb, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, auto_utg_straddle, voluntary_straddle, run_it_twice_enabled, run_it_twice, allow_run_it_twice, insurance_enabled, auto_muck_enabled, show_hand_enabled, allow_rabbit_hunt, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses, time_bank_enabled, ante_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_min_players, bomb_pot_ante_fixed, bomb_pot_variant, bomb_pot_next_due_at, bomb_pot_sched_state, bomb_pot_button_policy, bomb_pot_announce_seconds, wait_for_big_blind, seven_deuce_enabled, seven_deuce_amount, name, min_buy_in, max_buy_in, bbj_percent, all_in_or_fold, auto_start_players, run_it_mode, is_anonymous, ban_chat, restrict_observers, cap_enabled, cap_bb, pineapple_holdem, nit_game, maintain_percent_min, maintain_hands, career_percent_min, cluster_id, role, main_index, lifecycle'
    )
    .eq('id', tableId)
    .maybeSingle();

  if (error) {
    const msg = error.message || (error as any).details || JSON.stringify(error);
    throw new Error(`Failed to load table ${tableId}: ${msg}`);
  }
  if (!data) throw new Error(`Table ${tableId} not found`);
  const arena = parseTableArenaIdentity(data);
  // This engine currently settles through chip RPCs. Never open a Diamond
  // table on that financial path; dedicated custody is the next build phase.
  assertChipFundingArena(arena);
  return { ...data, arena };
}

/**
 * Load seated players with profiles for a table
 */
export async function loadSeatedPlayers(tableId: string) {
  /* ONE ROUND TRIP, NOT TWO (2026-09-07). This was a seats read followed by a
     profiles read keyed on the seats' user_ids - two PostgREST calls in
     series, at the 250-700ms each costs from the engine box, on the critical
     path of every deal (it is the roster the next hand is dealt from, read
     under the rest - see prepareNextHand). `fk_table_seats_user_id_profiles`
     lets PostgREST embed the profile in the seat row, so the same two
     queries are one request. The columns, the alias and the filters are the
     old ones; SEATED_PROFILE_SELECT is shared with the two-step path below,
     which is kept as the fallback for a PostgREST that cannot resolve the
     embedding (a schema-cache reload mid-flight answers PGRST200), so a
     roster read degrades to slower, never to empty. */
  const embedded = await supabase
    .from('table_seats')
    .select(
      `${SEAT_SELECT}, profile:profiles!fk_table_seats_user_id_profiles(${SEATED_PROFILE_SELECT}, is_vip, vip_tier, vip_expires_at)`
    )
    .eq('table_id', tableId)
    .is('left_at', null)
    .order('seat_number', { ascending: true });
  if (!embedded.error) {
    // supabase-js types an embedded relation as an array because it cannot
    // see the FK's cardinality; PostgREST returns an object for a to-one FK.
    // Read whichever shape arrives, and drop a seat whose profile is missing
    // exactly as the two-step path drops one the profiles read did not return.
    const rows = (embedded.data ?? []) as unknown as Array<
      SeatRow & { profile: SeatedProfileRow | SeatedProfileRow[] | null }
    >;
    const out: ReturnType<typeof seatedPlayerFrom>[] = [];
    for (const seat of rows) {
      const profile = Array.isArray(seat.profile) ? (seat.profile[0] ?? null) : seat.profile;
      if (profile) out.push(seatedPlayerFrom(seat, profile));
    }
    return out;
  }
  reportError(
    new Error(
      `loadSeatedPlayers: embedded roster read failed for ${tableId} (${embedded.error.message}); using the two-step read`
    ),
    'DB.load_seated_players_embed_fallback'
  );
  const { data: seats, error } = await supabase
    .from('table_seats')
    .select(SEAT_SELECT)
    .eq('table_id', tableId)
    .is('left_at', null)
    .order('seat_number', { ascending: true });
  if (error) {
    throw new Error('loadSeatedPlayers failed for ' + tableId + ': ' + error.message);
  }
  if (!seats || seats.length === 0) return [];
  const userIds = seats.map((d) => d.user_id);
  const { data: profiles, error: profileErr } = await supabase
    .from('profiles')
    .select(`${SEATED_PROFILE_SELECT}, is_vip, vip_tier, vip_expires_at`)
    .in('id', userIds);
  if (profileErr) {
    throw new Error('loadSeatedPlayers profiles failed for ' + tableId + ': ' + profileErr.message);
  }
  const profileMap = new Map<string, SeatedProfileRow>(
    (profiles ?? []).map((p) => [p.id, p as SeatedProfileRow])
  );
  return (seats as SeatRow[])
    .filter((seat) => profileMap.has(seat.user_id))
    .map((seat) => seatedPlayerFrom(seat, profileMap.get(seat.user_id)!));
}

const SEAT_SELECT =
  'user_id, stack, seat_number, time_bank_remaining, time_bank_uses_remaining, is_sitting_out, sit_out_at, entry_hold, entry_post_agreed';

interface SeatRow {
  user_id: string;
  stack: number;
  seat_number: number | null;
  time_bank_remaining: number | null;
  time_bank_uses_remaining: number | null;
  is_sitting_out: boolean | null;
  sit_out_at?: string | null;
  entry_hold?: string | null;
  entry_post_agreed?: boolean | null;
}

interface SeatedProfileRow {
  id: string;
  display_name: string | null;
  username: string | null;
  is_horse: boolean | null;
  horse_profile: unknown;
  avatar_url: string | null;
  use_real_name: boolean | null;
  equipped_frame: string | null;
  equipped_aura: string | null;
  is_vip?: boolean | null;
  vip_tier?: string | null;
  vip_expires_at?: string | null;
}

/** One seat + its profile -> the SeatedPlayer shape the engine deals from. Shared by both read paths. */
function seatedPlayerFrom(seat: SeatRow, profile: SeatedProfileRow) {
  return {
    user_id: seat.user_id,
    username: profile.is_horse
      ? profile.display_name || profile.username || 'Player'
      : profile.use_real_name
        ? profile.display_name || profile.username || 'Player'
        : profile.username || profile.display_name || 'Player',
    stack: seat.stack,
    seat_number: seat.seat_number || 1,
    is_horse: profile.is_horse || false,
    reconnect_membership: {
      is_vip: profile.is_vip,
      vip_tier: profile.vip_tier,
      vip_expires_at: profile.vip_expires_at,
    },
    horse_profile: (profile.horse_profile ?? undefined) as string | undefined,
    time_bank_remaining: seat.time_bank_remaining || 0,
    time_bank_uses_remaining: seat.time_bank_uses_remaining || 0,
    persisted_time_bank: {
      remainingSeconds: seat.time_bank_remaining,
      usesRemaining: seat.time_bank_uses_remaining,
    },
    is_sitting_out: seat.is_sitting_out === true,
    sit_out_at: seat.sit_out_at ?? null,
    entry_hold: seat.entry_hold ?? null,
    entry_post_agreed: seat.entry_post_agreed === true,
    avatar_url: profile.avatar_url || '',
    equipped_frame: profile.equipped_frame || '',
    equipped_aura: profile.equipped_aura || '',
  };
}

/**
 * Sync player stacks back to database after a hand
 */
/**
 * The PostgREST `or=` filter that matches a seat row ONLY when at least one
 * time-bank column differs from the value we are about to write.
 *
 * Exported so the shape can be pinned by a test: the failure mode that costs
 * something here is a filter that matches NOTHING when a value HAS changed,
 * which would silently drop a real write.
 */
export function timeBankChangedFilter(next: {
  time_bank_remaining?: number;
  time_bank_uses_remaining?: number;
}): string {
  const clauses: string[] = [];
  if (next.time_bank_remaining !== undefined) {
    clauses.push(
      `time_bank_remaining.neq.${next.time_bank_remaining}`,
      'time_bank_remaining.is.null'
    );
  }
  if (next.time_bank_uses_remaining !== undefined) {
    clauses.push(
      `time_bank_uses_remaining.neq.${next.time_bank_uses_remaining}`,
      'time_bank_uses_remaining.is.null'
    );
  }
  return clauses.join(',');
}

/**
 * Compare against this hand's raw roster read, not a process-wide cache or an
 * assumed successful write. Unchanged banks need no HTTP request. Unknown and
 * null baselines still write, including a real zero; the database filter below
 * remains the final no-op/WAL guard. Do not mark a failed write as persisted.
 */
function timeBankWritePayload(p: {
  time_bank_uses_remaining?: number;
  time_bank_remaining?: number;
  persisted_time_bank?: { remainingSeconds: number | null; usesRemaining: number | null };
}): { time_bank_uses_remaining?: number; time_bank_remaining?: number } {
  const payload: { time_bank_uses_remaining?: number; time_bank_remaining?: number } = {};
  if (
    p.time_bank_uses_remaining !== undefined &&
    p.time_bank_uses_remaining !== p.persisted_time_bank?.usesRemaining
  )
    payload.time_bank_uses_remaining = p.time_bank_uses_remaining;
  if (
    p.time_bank_remaining !== undefined &&
    p.time_bank_remaining !== p.persisted_time_bank?.remainingSeconds
  )
    payload.time_bank_remaining = p.time_bank_remaining;
  return payload;
}

export async function persistTimeBanks(
  tableId: string,
  players: {
    user_id: string;
    time_bank_uses_remaining?: number;
    time_bank_remaining?: number;
    persisted_time_bank?: { remainingSeconds: number | null; usesRemaining: number | null };
  }[]
): Promise<void> {
  // Stacks are already settled atomically. Keep genuine bank changes inside
  // the settlement barrier, but do not pay a round trip for every idle bank.
  await Promise.all(
    players.map(async (p) => {
      const payload = timeBankWritePayload(p);
      if (Object.keys(payload).length === 0) return;
      const { error } = await supabase
        .from('table_seats')
        .update(payload)
        .eq('table_id', tableId)
        .eq('user_id', p.user_id)
        .is('left_at', null)
        .or(timeBankChangedFilter(payload));
      // PostgREST resolves SQL failures; they must not masquerade as success.
      // The next fresh roster still differs and retries the remaining change.
      if (error) reportError(error, 'DB.persist_time_banks_failed');
    })
  );
}

/**
 * The PostgREST `or=` filter that matches a `tables` row ONLY when the seat
 * count or the status differs from what we are about to write.
 *
 * Exported for the same reason `timeBankChangedFilter` is: the failure mode
 * that costs something is a filter matching NOTHING when a value HAS changed,
 * which would silently drop a real recount. Every column therefore carries its
 * `is.null` arm — PostgREST `neq` is SQL three-valued logic, so a NULL column
 * does NOT satisfy `neq` and the row would be filtered out.
 *
 * `status` is quoted because it is text; the engine only ever writes
 * running/waiting/closed, but an unquoted reserved character in a PostgREST
 * filter value changes what the filter means rather than failing loudly.
 */
export function tableCountChangedFilter(next: {
  current_players?: number;
  status?: string;
}): string {
  const clauses: string[] = [];
  if (next.current_players !== undefined) {
    clauses.push(`current_players.neq.${next.current_players}`, 'current_players.is.null');
  }
  if (next.status !== undefined) {
    clauses.push(`status.neq."${next.status}"`, 'status.is.null');
  }
  return clauses.join(',');
}

/**
 * Update table player count and status.
 *
 * ═══ THE RECOUNT THAT WROTE A NUMBER IT ALREADY HELD (2026-09-06) ═══════════
 *
 * This is the AUTHORITATIVE recount at the end of every hand
 * (ServerTableEngineSettlement step 15), and it wrote unconditionally:
 * 1,604,259 calls since the 09-02 stats reset, every one of them producing a
 * heap tuple, a WAL record, index entries, two AFTER-UPDATE triggers, and — the
 * expensive part — a logical decode of a 154-COLUMN row for Supabase Realtime.
 *
 * `tables` is the widest published table on the platform, and apply_rls costs
 * roughly one dynamic cast plus one column-privilege check per column: measured
 * 2026-09-06 against live WAL, 28.4 ms of database time PER CHANGE, 221 changes
 * per 15 seconds, 6,277 ms — 27% of all realtime decoding, on a poller that was
 * already spending 22.9 s of CPU per 15 s of WAL and therefore falling behind.
 *
 * And it almost never had anything to say. `current_players` is the count of
 * seats with `left_at IS NULL` and `status` is derived from it, so both are
 * constant across every hand at a table whose seats did not change. Measured on
 * production the same day, across all 472 open tables:
 *
 *     current_players already equal to the live seat count   468 of 472
 *     status already agreeing with the seat count            445 of 472
 *     recounts that would write nothing                      93.4%
 *
 * The guard is a FILTER, not a diff held in memory — the same shape, and for
 * the same reasons, as `timeBankChangedFilter` (2026-09-02). If neither column
 * differs from what is stored, zero rows match, Postgres writes nothing, and no
 * WAL record exists to decode. There is no cache to go stale, it is correct
 * across an engine restart, and it is correct against a concurrent writer
 * because the comparison happens inside the UPDATE, against the current row.
 * A recount that genuinely moved still writes exactly as it did before.
 *
 * This does NOT weaken the recount. The caller still counts seats in the
 * database every hand and still passes the authoritative number; what changes
 * is that agreeing with the stored value is no longer a write.
 */
export async function updateTableStatus(
  tableId: string,
  playerCount: number,
  status: string = 'running'
): Promise<void> {
  const { error } = await supabase
    .from('tables')
    .update({ current_players: playerCount, status })
    .eq('id', tableId)
    .neq('status', 'closed')
    .or(tableCountChangedFilter({ current_players: playerCount, status }));
  if (error) {
    throw new Error(`table ${tableId} status recount failed: ${error.message}`);
  }
}

/**
 * Read the active seats and stored summary in one database snapshot. A stable
 * table needs no second HTTP request. Changed summaries still use the database
 * comparison filter; missing/failed reads never manufacture an empty table.
 */
export async function reconcileTableSeatCount(
  tableId: string,
  canMutate: () => boolean = () => true
): Promise<number | null> {
  const { data, error } = await supabase
    .from('tables')
    .select('current_players,status,seats:table_seats!table_seats_table_id_fkey(user_id)')
    .eq('id', tableId)
    .is('seats.left_at', null)
    .maybeSingle();
  if (error || !data || !Array.isArray(data.seats)) {
    reportError(
      new Error(
        `table_unlock: seat count unavailable (${error?.message ?? 'missing seat relation'}); table status left unchanged`
      ),
      'ServerTableEngine.table_unlock_count_unavailable'
    );
    return null;
  }
  const count = data.seats.length;
  const status = count >= 2 ? 'running' : 'waiting';
  if (data.current_players !== count || data.status !== status) {
    if (!canMutate()) return null;
    const { error: updateError } = await supabase
      .from('tables')
      .update({ current_players: count, status })
      .eq('id', tableId)
      .neq('status', 'closed')
      .or(tableCountChangedFilter({ current_players: count, status }));
    if (updateError) {
      reportError(
        new Error(`table_unlock: summary update failed (${updateError.message})`),
        'ServerTableEngine.table_unlock_update_failed'
      );
    }
  }
  return count;
}
