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
      'id, club_id, small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, rake_percent, rake_cap_bb, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, auto_utg_straddle, voluntary_straddle, run_it_twice_enabled, run_it_twice, allow_run_it_twice, insurance_enabled, auto_muck_enabled, show_hand_enabled, allow_rabbit_hunt, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses, time_bank_enabled, ante_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_min_players, bomb_pot_ante_fixed, bomb_pot_variant, bomb_pot_next_due_at, bomb_pot_sched_state, bomb_pot_button_policy, bomb_pot_announce_seconds, wait_for_big_blind, seven_deuce_enabled, seven_deuce_amount, name, min_buy_in, max_buy_in, bbj_percent, all_in_or_fold, auto_start_players, run_it_mode, is_anonymous, ban_chat, restrict_observers, cap_enabled, cap_bb, pineapple_holdem, nit_game, maintain_percent_min, maintain_hands, career_percent_min'
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
    //
    // sit_out_at added 2026-08-28, and it is the half that makes the eviction
    // actually fire. The boolean survived a restart; the CLOCK did not, because
    // it was a field on an in-memory Map. restoreSitOutsFromSeats() re-stamped
    // it to Date.now() on every boot, so on a table whose engine recycled more
    // often than every five minutes the 5-minute limit could never mature and
    // the seat was held forever. Dan 2026-08-28: "FOR SOME REASON THIS NEVER
    // KICKS THE USER OFF THE CASH GAME AFTER THE 5 MIN."
    // entry_hold / entry_post_agreed added 2026-08-30, and they are the THIRD
    // instance of the same lesson on this one query: the engine wrote a fact
    // and never read it back. is_sitting_out (2026-08-25) dealt cards to
    // players who had sat out; sit_out_at (2026-08-28) handed every sat-out
    // seat a fresh five minutes on every restart so the eviction never fired.
    // These two are the cash entry hold — without them a deploy releases every
    // held player free, button-eligible, and re-prompts anyone who had already
    // agreed to post.
    .select(
      'user_id, stack, seat_number, time_bank_remaining, time_bank_uses_remaining, is_sitting_out, sit_out_at, entry_hold, entry_post_agreed'
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
      'id, display_name, username, is_horse, horse_profile, avatar_url:arena_avatar_url, use_real_name, equipped_frame, equipped_aura'
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
        /* The persisted sit-out clock. Null whenever is_sitting_out is false —
           a database trigger (trg_stamp_sit_out_at) owns both, so the pair can
           never disagree regardless of which writer touched the row. */
        sit_out_at: (seat as { sit_out_at?: string | null }).sit_out_at ?? null,
        /* The persisted cash entry hold, read by restoreEntryHoldsFromSeats()
           once per process on boot. Mapped through here rather than queried
           separately so the restore has no round trip of its own — it reads
           the roster the engine already loaded. */
        entry_hold: (seat as { entry_hold?: string | null }).entry_hold ?? null,
        entry_post_agreed:
          (seat as { entry_post_agreed?: boolean | null }).entry_post_agreed === true,
        avatar_url: profile.avatar_url || '',
        /* Cosmetics ride the avatar's pipeline rather than getting one of their
           own: same query, same snapshot field group, same client mapper. They
           are re-read here once per hand alongside the avatar, so a player who
           equips a frame mid-session is wearing it on everyone's felt by the
           next deal even if their realtime subscription dropped. */
        equipped_frame: profile.equipped_frame || '',
        equipped_aura: profile.equipped_aura || '',
      };
    });
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

export async function syncStacks(
  tableId: string,
  players: {
    user_id: string;
    stack: number;
    time_bank_uses_remaining?: number;
    time_bank_remaining?: number;
  }[],
  handNumber?: number
): Promise<void> {
  /* ZERO-DRIFT phase 5 (2026-08-31): when the caller identifies the hand,
     the stack write goes through fn_ca_settle_hand_stacks_absolute - ONE
     transaction that locks every named seat and writes all stacks or none,
     idempotent on (table, hand): a crash-and-resend replays the stored
     result instead of double-writing, and a partial hand write can no
     longer persist (remaining risk #1 in the zero-drift audit, doc 05).
     Rake/BBJ conservation checking arrives when those figures are wired
     through (the RPC runs lenient with rake=null). Any RPC failure falls
     back to the legacy per-seat loop below - the write path never narrows.
     Time banks are not money and keep their own writes either way. */
  if (handNumber !== undefined && handNumber !== null && players.length > 0) {
    try {
      const { data, error } = await supabase.rpc('fn_ca_settle_hand_stacks_absolute', {
        p_table_id: tableId,
        p_hand_number: handNumber,
        p_stacks: players.map((p) => ({
          user_id: p.user_id,
          stack: Math.round(p.stack * 100) / 100,
        })),
        p_rake: null,
        p_bbj: null,
      });
      const ok =
        !error && (data as { success?: boolean; replay?: boolean } | null)?.success === true;
      if (ok) {
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
        return;
      }
      /* chip-std Lane F (2026-09-02): a CONSERVATION refusal is not a transport
         failure. The database has just said that these stacks, written
         absolutely, would mint or destroy chips on this table (for a
         tournament table: the named seats would no longer sum to what they
         summed to before the hand). Falling through to the per-seat loop
         would persist exactly the total that was refused, seat by seat, with
         no lock and no check - the fallback exists for a database that could
         not be reached, not for one that answered "no". Report it and leave
         the pre-hand stacks standing; the drift incident the RPC filed
         carries the numbers. */
      const refusal = String((data as { error?: unknown } | null)?.error ?? '');
      if (!error && /^conservation violation/i.test(refusal)) {
        reportError(
          new Error(
            `[DB] hand-stack settle REFUSED for table ${tableId} hand ${handNumber}: ${refusal} ` +
              `- not falling back to per-seat writes; pre-hand stacks stand`
          ),
          'DB.settle_hand_stacks_conservation_refused'
        );
        return;
      }
      reportError(
        new Error(
          `[DB] atomic hand-stack settle declined for table ${tableId} hand ${handNumber} ` +
            `(${error ? error.message : JSON.stringify(data)}) - falling back to per-seat writes`
        ),
        'DB.settle_hand_stacks_fallback'
      );
    } catch (err) {
      reportError(err, 'DB.settle_hand_stacks_transport_fallback');
    }
  }
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
          `after 3 attempts each - ${failures.join('; ')}`
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
