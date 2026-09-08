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
      'id, club_id, small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, rake_percent, rake_cap_bb, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, auto_utg_straddle, voluntary_straddle, run_it_twice_enabled, run_it_twice, allow_run_it_twice, insurance_enabled, auto_muck_enabled, show_hand_enabled, allow_rabbit_hunt, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses, time_bank_enabled, ante_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_min_players, bomb_pot_ante_fixed, bomb_pot_variant, bomb_pot_next_due_at, bomb_pot_sched_state, bomb_pot_button_policy, bomb_pot_announce_seconds, wait_for_big_blind, seven_deuce_enabled, seven_deuce_amount, name, min_buy_in, max_buy_in, bbj_percent, all_in_or_fold, auto_start_players, run_it_mode, is_anonymous, ban_chat, restrict_observers, cap_enabled, cap_bb, pineapple_holdem, nit_game, maintain_percent_min, maintain_hands, career_percent_min, cluster_id, role, main_index, lifecycle'
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

export interface StackWriteOptions {
  /** Rake taken off the felt this hand. Declared, so the database asserts the identity. */
  rake?: number | null;
  /** Jackpot drop taken off the felt this hand. */
  bbj?: number | null;
  /** Distinguishes a second write for the same hand (unused since 2026-09-04; kept for the RPC). */
  ref?: string | null;
  /** Chips that arrived on the felt from a declared pool this write (a BBJ payout). */
  inflow?: number | null;
  /**
   * When present, require proof that this same transaction mirrored every
   * resulting seat stack into the tournament standings source.
   */
  expectedTournamentId?: string | null;
}

export interface TournamentStackProof {
  written?: unknown;
  tournament_id?: unknown;
  tournament_players_synced?: unknown;
  tournament_player_count?: unknown;
  tournament_player_user_ids?: unknown;
  tournament_player_chips?: unknown;
}

/** Validate the exact tournament-standing proof returned by the hand RPC. */
export function tournamentStackProofIsExact(
  proof: TournamentStackProof,
  expectedTournamentId: string,
  expectedPlayerIds: readonly string[]
): boolean {
  const expectedUsers = [...new Set(expectedPlayerIds)].sort();
  if (expectedUsers.length !== expectedPlayerIds.length) return false;
  const returnedUsers = Array.isArray(proof.tournament_player_user_ids)
    ? proof.tournament_player_user_ids.filter(
        (userId): userId is string => typeof userId === 'string'
      )
    : [];
  const returnedChips = Array.isArray(proof.tournament_player_chips)
    ? proof.tournament_player_chips
    : [];
  const written =
    proof.written && typeof proof.written === 'object' && !Array.isArray(proof.written)
      ? (proof.written as Record<string, unknown>)
      : null;
  const writtenUsers = written ? Object.keys(written).sort() : [];
  const chipUsers = returnedChips.map((row) =>
    row && typeof row === 'object' && typeof (row as { user_id?: unknown }).user_id === 'string'
      ? String((row as { user_id: string }).user_id)
      : null
  );
  const chipAmountsAreExact = returnedChips.every((row) => {
    if (!row || typeof row !== 'object') return false;
    const userId = (row as { user_id?: unknown }).user_id;
    const amount = Number((row as { chips?: unknown }).chips);
    return (
      typeof userId === 'string' &&
      Number.isFinite(amount) &&
      amount >= 0 &&
      Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7 &&
      written !== null &&
      Number(written[userId]) === amount
    );
  });
  return (
    proof.tournament_id === expectedTournamentId &&
    proof.tournament_players_synced === true &&
    Number(proof.tournament_player_count) === expectedUsers.length &&
    returnedUsers.length === expectedUsers.length &&
    returnedUsers.every((userId, index) => userId === expectedUsers[index]) &&
    chipUsers.length === expectedUsers.length &&
    chipUsers.every((userId, index) => userId === expectedUsers[index]) &&
    writtenUsers.length === expectedUsers.length &&
    writtenUsers.every((userId, index) => userId === expectedUsers[index]) &&
    chipAmountsAreExact
  );
}

/**
 * The same settlement promise owns every retry. The measured PostgREST schema
 * reload is about 28 seconds, so the retry schedule reaches 41 seconds while
 * remaining inside the dealing loop's five-minute settlement barrier even if
 * every RPC consumes its full 15-second database deadline.
 *
 * This is intentionally an exported value rather than an off-path scheduler:
 * the law test can prove the budget, and stop/drain/terminal closeout continue
 * to see the exact promise that owns the exact hand payload.
 */
export const STACK_WRITE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  200, 400, 800, 1_600, 3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
]);

export async function syncStacks(
  tableId: string,
  players: {
    user_id: string;
    stack: number;
    /**
     * Chip standard 2026-09-04: the stack this seat was dealt from. When every
     * player carries it, the database writes row + (stack - stack_before) -
     * the hand's DIFFERENCE - instead of the absolute figure, so a credit that
     * landed on the row while the engine's copy was stale (a mid-hand add-on
     * resolved by settlement step 8e after the dealing loop had reloaded
     * seats, a horse funding, a between-hands add-on) is preserved rather than
     * erased. Measured before this: 64 add-ons / 7,685.70 chips destroyed in
     * three hours, ~15% of all mid-hand add-ons.
     */
    stack_before?: number;
    time_bank_uses_remaining?: number;
    time_bank_remaining?: number;
  }[],
  handNumber?: number,
  options: StackWriteOptions = {}
): Promise<boolean> {
  if (players.length === 0) return false;
  if (handNumber === undefined || handNumber === null) {
    /* Every hand result names its hand (settlement step 8 reads the snapshot).
       A write with no hand number used to take the unchecked per-seat loop -
       absolute values, no lock, no conservation, no idempotency - which was
       one of the two ways the felt lost chips (chip standard 2026-09-04). It
       has no caller left; refuse rather than reopen it. */
    reportError(
      new Error(`[DB] syncStacks called for table ${tableId} without a hand number - refused`),
      'DB.sync_stacks_without_hand'
    );
    return false;
  }

  /* ZERO-DRIFT phase 5 (2026-08-31) + chip standard (2026-09-04): the stack
     write is ONE call to fn_ca_settle_hand_stacks_absolute - one transaction
     that locks every named seat and writes all stacks or none, idempotent on
     (table, hand): a crash-and-resend replays the stored result instead of
     double-writing. It runs in DELTA mode whenever every seat carries
     stack_before, and declares rake and BBJ so the database asserts
     sum(delta) = inflow - rake - bbj on every hand, cash or tournament.

     THERE IS NO FALLBACK. The per-seat loop this used to fall back to wrote
     absolute values from engine memory with no lock and no check, and ran on
     more than a quarter of all cash hands (the no-op trigger made the RPC
     report "seat write failed" for any hand in which one stack did not move).
     It is exactly the write that erased credits. A refusal from the database
     is final. An unreachable database or incomplete tournament receipt keeps
     this SAME promise alive through the schema-reload window. No timer queue,
     watcher, reconciler, or successor engine ever owns this payload. */

  const rounded = (n: number): number => Math.round(n * 100) / 100;
  const deltaMode = players.every(
    (p) => typeof p.stack_before === 'number' && Number.isFinite(p.stack_before)
  );
  if (!deltaMode) {
    reportError(
      new Error(
        `[DB] hand-stack write for table ${tableId} hand ${handNumber} is ABSOLUTE - ` +
          `${players.filter((p) => typeof p.stack_before !== 'number').length}/${players.length} seat(s) carry no stack_before`
      ),
      'DB.settle_hand_stacks_absolute_mode'
    );
  }
  const payload = {
    p_table_id: tableId,
    p_hand_number: handNumber,
    p_stacks: players.map((p) =>
      deltaMode
        ? {
            user_id: p.user_id,
            stack: rounded(p.stack),
            stack_before: rounded(p.stack_before as number),
          }
        : { user_id: p.user_id, stack: rounded(p.stack) }
    ),
    p_rake: options.rake ?? null,
    p_bbj: options.bbj ?? null,
    p_ref: options.ref ?? null,
    p_inflow: options.inflow ?? null,
  };

  type SettleResult = {
    success?: boolean;
    replay?: boolean;
    reason?: string;
    error?: unknown;
    rebased?: Record<string, number>;
    written?: Record<string, number>;
    tournament_id?: unknown;
    tournament_players_synced?: unknown;
    tournament_player_count?: unknown;
    tournament_player_user_ids?: unknown;
    tournament_player_chips?: unknown;
  };
  /* The immutable payload above is closed over by every attempt. Reusing the
     same object is intentional: (table, hand) is the RPC's idempotency key, and
     a retry must never be rebuilt from newer in-memory stacks. */
  type Verdict =
    | { kind: 'landed' }
    | { kind: 'refused'; detail: string }
    | { kind: 'unconfirmed'; error: string };

  let invalidTournamentProofReported = false;
  const attemptStackWrite = async (): Promise<Verdict> => {
    let data: SettleResult | null = null;
    let error: { message?: string } | null = null;
    try {
      const res = (await supabase.rpc('fn_ca_settle_hand_stacks_absolute', payload)) as {
        data: SettleResult | null;
        error: { message?: string } | null;
      };
      data = res.data;
      error = res.error;
    } catch (err) {
      error = { message: err instanceof Error ? err.message : String(err) };
    }

    if (!error && data?.success === true) {
      const expectedTournamentId = options.expectedTournamentId ?? null;
      if (expectedTournamentId !== null) {
        if (
          !tournamentStackProofIsExact(
            data,
            expectedTournamentId,
            players.map((player) => player.user_id)
          )
        ) {
          if (!invalidTournamentProofReported) {
            invalidTournamentProofReported = true;
            reportError(
              new Error(
                `[DB] tournament hand-stack settle for table ${tableId} hand ${handNumber} returned incomplete standings proof`
              ),
              'DB.settle_hand_stacks_tournament_proof_invalid'
            );
          }
          return {
            kind: 'unconfirmed',
            error: 'the RPC returned success without the exact tournament standings receipt',
          };
        }
      }
      const rebased =
        data.rebased && typeof data.rebased === 'object' ? Object.keys(data.rebased) : [];
      if (rebased.length > 0) {
        // Not an error: the row held a credit the engine never saw and the
        // database kept it. Logged so the rate is visible; the register is
        // ca_seat_stack_rebases.
        console.log(
          `[DB] hand ${handNumber} at ${tableId}: ${rebased.length} seat(s) rebased onto credits the engine had not seen ` +
            JSON.stringify(data.rebased)
        );
      }
      await persistTimeBanks(tableId, players);
      return { kind: 'landed' };
    }

    /* chip-std Lane F (2026-09-02) + 2026-09-04: a refusal is not a transport
       failure. The database has said that this write would mint or destroy
       chips on this table (a conservation violation, a negative resulting
       stack), or that a named seat is gone. Writing around it - seat by seat,
       absolutely - would persist exactly the total that was refused with no
       lock and no check. Report it and leave the seats as they stand; the
       drift incident the RPC filed carries the numbers. */
    const refusal = String(data?.error ?? '');
    if (!error && data?.success === false && data.reason !== 'in_flight') {
      if (/^conservation violation/i.test(refusal) || /^negative stack/i.test(refusal)) {
        reportError(
          new Error(
            `[DB] hand-stack settle REFUSED for table ${tableId} hand ${handNumber}: ${refusal} ` +
              `- no fallback; pre-hand stacks stand`
          ),
          'DB.settle_hand_stacks_conservation_refused'
        );
      } else {
        reportError(
          new Error(
            `[DB] hand-stack settle declined for table ${tableId} hand ${handNumber} ` +
              `(${data.reason ?? 'unknown'}: ${refusal || JSON.stringify(data)}) - no fallback; seats stand as written`
          ),
          'DB.settle_hand_stacks_declined'
        );
      }
      return { kind: 'refused', detail: refusal || String(data.reason ?? 'unknown') };
    }

    return {
      kind: 'unconfirmed',
      error: error ? String(error.message ?? error) : `in_flight (${JSON.stringify(data)})`,
    };
  };

  let lastError = '';
  for (let attempt = 0; attempt <= STACK_WRITE_RETRY_DELAYS_MS.length; attempt++) {
    const verdict = await attemptStackWrite();
    if (verdict.kind === 'landed') return true;
    if (verdict.kind === 'refused') return false;
    lastError = verdict.error;
    const delayMs = STACK_WRITE_RETRY_DELAYS_MS[attempt];
    if (delayMs !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const attempts = STACK_WRITE_RETRY_DELAYS_MS.length + 1;
  const retryWindowMs = STACK_WRITE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  reportError(
    new Error(
      `[DB] hand-stack write UNCONFIRMED for table ${tableId} hand ${handNumber} after ` +
        `${attempts} attempts over at least ${Math.round(retryWindowMs / 1000)}s - ${lastError} - ` +
        `payload ${JSON.stringify(payload)}`
    ),
    'DB.settle_hand_stacks_unconfirmed'
  );
  try {
    const { raiseFinancialAlert } = await import('../financialAlerts.js');
    await raiseFinancialAlert(
      'critical',
      'DB.settle_hand_stacks_unconfirmed',
      `Hand #${handNumber} at table ${tableId}: exact stack receipt remained unconfirmed after ${attempts} attempts`,
      {
        table_id: tableId,
        hand_number: handNumber,
        attempts,
        retry_window_ms: retryWindowMs,
        last_error: lastError,
        payload,
      }
    );
  } catch (err) {
    reportError(err, 'DB.settle_hand_stacks_unconfirmed_alert_failed');
  }
  return false;
}

async function persistTimeBanks(
  tableId: string,
  players: { user_id: string; time_bank_uses_remaining?: number; time_bank_remaining?: number }[]
): Promise<void> {
  // Stacks are settled atomically; persist the non-money seat fields.
  await Promise.all(
    players
      .filter(
        (p) => p.time_bank_uses_remaining !== undefined || p.time_bank_remaining !== undefined
      )
      .map(async (p) => {
        const payload: Record<string, unknown> = {};
        if (p.time_bank_uses_remaining !== undefined)
          payload.time_bank_uses_remaining = p.time_bank_uses_remaining;
        if (p.time_bank_remaining !== undefined)
          payload.time_bank_remaining = p.time_bank_remaining;
        await supabase
          .from('table_seats')
          .update(payload)
          .eq('table_id', tableId)
          .eq('user_id', p.user_id)
          .is('left_at', null)
          // WRITE ONLY WHAT CHANGED (2026-09-02, performance).
          //
          // This ran for EVERY seated player after EVERY hand, and a
          // time bank almost never moves - it only changes on the hands
          // where somebody actually burns it. So the overwhelming
          // majority of these were an UPDATE that set a column to the
          // value it already held.
          //
          // Postgres does not care much; Realtime does. `table_seats` is
          // in the `supabase_realtime` publication, so every one of these
          // no-op writes produced a WAL record that `realtime.apply_rls`
          // then decoded and RLS-filtered for every subscriber on the
          // table. Measured 2026-09-02: 408,121 of these calls, 98.7% of
          // all table_seats writes, on a table that is 36% of everything
          // Realtime decodes - and `realtime.list_changes` was the single
          // largest consumer of the whole database at 17.5% of total time
          // with a 460 ms mean, which is felt at the table as lag.
          //
          // The guard is a FILTER, not a diff we track in memory: if
          // neither column differs from what is stored, zero rows match,
          // Postgres writes nothing, and no WAL record is produced. There
          // is no cache to go stale, it is correct across an engine
          // restart and against any concurrent writer, and a genuine
          // change still writes exactly as before.
          //
          // `is.null` is in the OR deliberately. PostgREST `neq` uses SQL
          // three-valued logic, so a NULL column would NOT match `neq`
          // and the row would be filtered out - silently skipping a write
          // that IS needed. Both columns are NOT NULL with defaults today
          // (`20260313_time_bank_*`, pinned by RestartFidelity), and this
          // clause is what keeps the guard correct if that ever changes.
          .or(
            timeBankChangedFilter({
              time_bank_remaining: p.time_bank_remaining,
              time_bank_uses_remaining: p.time_bank_uses_remaining,
            })
          );
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
    // A hand that began before tournament completion may reach this recount
    // after the terminal transaction has closed the table. The compare-and-set
    // makes that delayed writer a no-op instead of reopening a completed game.
    .neq('status', 'closed')
    .or(tableCountChangedFilter({ current_players: playerCount, status }));
  if (error) {
    throw new Error(`table ${tableId} status recount failed: ${error.message}`);
  }
}
