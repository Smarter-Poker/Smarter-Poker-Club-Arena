/**
 * Supabase helpers — hand state snapshots for crash recovery.
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { bindToProcessRoot } from './dataActorContext.js';

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
  /**
   * Folded in on 2026-09-04. These used to be written by a SECOND statement
   * (saveHandSnapshotExtras) against the row this call had just inserted,
   * costing ~1.2M extra row versions per stats window on the largest table in
   * the database - and only 16.5% of them were HOT, so most also rewrote all
   * three indexes. The row that lands is identical; it now lands in one
   * statement.
   */
  pendingDeadlines?: PendingDeadline[];
  disconnectStates?: Record<string, DisconnectStateEntry>;
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
      p_pending_deadlines: params.pendingDeadlines ?? [],
      p_disconnect_states: params.disconnectStates ?? {},
    });
    if (error) throw error;
  } catch (error) {
    // Gameplay snapshot callers deliberately remain best-effort at the engine
    // boundary. Teardown asks that same boundary to reject, so swallowing here
    // would make its cleanup certificate claim success after an unwritten row.
    console.warn(`[saveHandStateSnapshot] Error:`, error instanceof Error ? error.message : error);
    throw error;
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
    if (error) throw error;
  } catch (error) {
    // Settlement deliberately attaches its own non-fatal reporter, while crash
    // recovery awaits this proof before starting fresh. Preserve the rejection
    // so both callers can enforce the policy their boundary documents.
    console.warn(`[completeHandSnapshot] Error:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Get active (incomplete) hand snapshot for crash recovery.
 * Returns null only when the database proves that no active hand exists.
 * An unreadable snapshot is not an empty snapshot: callers must stop startup
 * rather than deal over a hand whose durable state could not be inspected.
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
    if (error) throw error;
    if (!data || data.length === 0) return null;
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
  } catch (error) {
    console.warn(`[getActiveHandSnapshot] Exception:`, error);
    throw error;
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
  // 2026-09-04: optional carry-over so a restore continues rather than
  // restarts (DisconnectEngine.DisconnectFsmEntry is the authority).
  sitOutSinceMs?: number | null;
  sitOutOrbits?: number;
  sitOutReason?: 'voluntary' | 'forced' | null;
  strikes?: number;
  awayBlindSbCharged?: boolean;
  awayBlindBbCharged?: boolean;
  pageLeftAtMs?: number | null;
}

/**
 * Get the active snapshot with pending_deadlines + disconnect_states.
 * Used by ServerTableEngine.start() to rehydrate the deadline scheduler
 * and disconnect FSM after a crash or restart. Returns null if no active
 * hand snapshot exists. Database and transport failures reject so engine
 * startup cannot reinterpret UNKNOWN recovery state as an empty table.
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
    if (error) throw error;
    if (!data) return null;
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
  } catch (error) {
    console.warn(`[getActiveHandSnapshotFull] Exception:`, error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESENCE ACROSS THE HOURLY RESTART (disconnect audit item 2, 2026-09-04)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A parked table's presence FSM is read back only while it is this fresh.
 * The break is five minutes and the cut-over lands inside it; anything older
 * describes a table that has since dealt, and a seat that re-registered
 * meanwhile wins anyway (restoreFsmStates never clobbers a live entry).
 */
export const PARKED_PRESENCE_FRESH_MS = 20 * 60_000;

/**
 * Write the presence FSM for a table that is parking for the restart.
 * One row per table (engine_presence_parked, service role only). Best
 * effort: a failure here costs the next boot its strike counts and blind
 * budgets, which is what every boot cost before this existed.
 */
export interface ParkedTimeBank {
  occupancyId: string;
  remainingSeconds: number;
  usesRemaining: number;
  initialSeconds: number;
  baseSeconds: number;
  dbConsumedSeconds: number;
  unlimitedActivations?: boolean;
}

export async function savePresenceAtPark(params: {
  tableId: string;
  disconnectStates: Record<string, DisconnectStateEntry>;
  engineInstance?: string | null;
  timeBanks?: Record<string, ParkedTimeBank>;
  handNumber?: number;
}): Promise<boolean> {
  try {
    const parkedAt = new Date().toISOString();
    const { error } = await supabase.from('engine_presence_parked').upsert(
      {
        table_id: params.tableId,
        disconnect_states: params.disconnectStates,
        parked_at: parkedAt,
        engine_instance: params.engineInstance ?? null,
        time_bank_snapshot:
          params.timeBanks && Number.isSafeInteger(params.handNumber)
            ? { version: 1, parkedAt, handNumber: params.handNumber, players: params.timeBanks }
            : null,
      },
      { onConflict: 'table_id' }
    );
    if (error) {
      console.warn(`[savePresenceAtPark] ${params.tableId}: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[savePresenceAtPark] Exception:`, e);
    return false;
  }
}

/**
 * THE OUTCOME OF WRITING A TERMINAL ENGINE'S STOPPED CUSTODY (2026-09-26).
 *
 * Three answers, never two (CLAUDE.md 10.86 rule 1): `parked` - the database
 * wrote exactly this custody; `refused` - the database answered and named why
 * it would not (newer state exists, or a transfer holds this row as evidence),
 * so nothing was written and nothing must be written over it; `unknown` - no
 * answer, so nothing may be assumed either way.
 */
export type StoppedCustodyParkOutcome =
  | { status: 'parked' }
  | { status: 'refused'; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * WRITE A TERMINAL ENGINE'S FROZEN TIME BANK AS THE PROCESS (2026-09-26).
 *
 * `savePresenceAtPark` is an unconditional upsert sent with whatever data
 * authority the caller is running under. A terminal tournament engine runs
 * under its manager's lease generation, and once that lease is gone
 * `fn_smarter_data_api_pre_request` fences every request it sends. On
 * 2026-09-26 that refused all 698 stopped-custody writes in the last sixteen
 * minutes before the restart (`TOURNAMENT_MANAGER_FENCED: lease generation is
 * no longer current`), the banks never reached disk, and 134,904 manager stops
 * failed "retained time-bank custody".
 *
 * A bank balance frozen at a known hand number is not the manager's data to
 * exercise authority over; it is what the process is holding. So this runs at
 * the process root (the `service` actor), and the database function it calls
 * writes only when the write cannot clobber newer state - no hand dealt after
 * `handNumber`, no newer park, no F06 mixed transfer holding the row as its
 * evidence - and otherwise refuses by name.
 */
export const parkStoppedTimeBankCustody = bindToProcessRoot(
  async (params: {
    tableId: string;
    tournamentId: string;
    generation: string | null;
    handNumber: number;
    parkedAt: string;
    disconnectStates: Record<string, DisconnectStateEntry>;
    timeBanks: Record<string, ParkedTimeBank>;
    engineInstance: string;
  }): Promise<StoppedCustodyParkOutcome> => {
    try {
      const { data, error } = await supabase.rpc('fn_park_stopped_time_bank_custody', {
        p_table_id: params.tableId,
        p_tournament_id: params.tournamentId,
        p_generation: params.generation,
        p_hand_number: params.handNumber,
        p_parked_at: params.parkedAt,
        p_disconnect_states: params.disconnectStates,
        p_players: params.timeBanks,
        p_engine_instance: params.engineInstance,
      });
      if (error) {
        console.warn(`[parkStoppedTimeBankCustody] ${params.tableId}: ${error.message}`);
        return { status: 'unknown', reason: error.message };
      }
      const reply = data as {
        ok?: unknown;
        refused?: unknown;
        table_id?: unknown;
        hand_number?: unknown;
      } | null;
      if (
        reply?.ok === true &&
        reply.table_id === params.tableId &&
        Number(reply.hand_number) === params.handNumber
      )
        return { status: 'parked' };
      if (reply?.ok === false && typeof reply.refused === 'string') {
        console.warn(`[parkStoppedTimeBankCustody] ${params.tableId}: refused (${reply.refused})`);
        return { status: 'refused', reason: reply.refused };
      }
      return { status: 'unknown', reason: 'malformed_reply' };
    } catch (e) {
      console.warn(`[parkStoppedTimeBankCustody] Exception:`, e);
      return { status: 'unknown', reason: String((e as Error)?.message ?? e) };
    }
  }
);

/**
 * The presence FSM a table parked with, if it parked recently. Null when
 * there is no row or the row is older than PARKED_PRESENCE_FRESH_MS.
 */
export async function loadPresenceFromPark(
  tableId: string,
  nowMs: number = Date.now()
): Promise<Record<string, DisconnectStateEntry> | null> {
  try {
    const { data, error } = await supabase
      .from('engine_presence_parked')
      .select('disconnect_states, parked_at')
      .eq('table_id', tableId)
      .maybeSingle();
    if (error || !data) return null;
    const parkedAt = Date.parse(String(data.parked_at));
    if (!Number.isFinite(parkedAt) || nowMs - parkedAt > PARKED_PRESENCE_FRESH_MS) return null;
    return (data.disconnect_states as Record<string, DisconnectStateEntry>) ?? null;
  } catch (e) {
    console.warn(`[loadPresenceFromPark] Exception:`, e);
    return null;
  }
}

/**
 * Read explicitly initialized banks at the caller's proven completed-hand
 * boundary. Startup reads authoritative history and excludes crash recovery
 * before reaching this function; roster adoption then requires the exact
 * occupancy. Those identities, not elapsed wall time, establish validity.
 * A frozen table can remain at the same boundary throughout a long outage.
 * Expiring its bank after twenty minutes loses purchased time (or grants a
 * second allowance), even though neither a hand nor a seat changed.
 * Presence alone still uses its TTL because it lacks these identity guards.
 */
export async function loadTimeBanksFromPark(
  tableId: string,
  handNumber: number,
  nowMs = Date.now()
): Promise<Record<string, ParkedTimeBank>> {
  const { data, error } = await supabase
    .from('engine_presence_parked')
    .select('time_bank_snapshot, parked_at')
    .eq('table_id', tableId)
    .maybeSingle();
  if (error) throw error;
  const snapshot = data?.time_bank_snapshot;
  const parkedAt = Date.parse(String(data?.parked_at));
  if (
    !Number.isSafeInteger(handNumber) ||
    handNumber < 0 ||
    !Number.isFinite(nowMs) ||
    !snapshot ||
    snapshot.version !== 1 ||
    snapshot.handNumber !== handNumber ||
    !Number.isFinite(parkedAt) ||
    nowMs < parkedAt ||
    Date.parse(String(snapshot.parkedAt)) !== parkedAt ||
    !snapshot.players ||
    typeof snapshot.players !== 'object' ||
    Array.isArray(snapshot.players)
  )
    return {};
  const valid: Record<string, ParkedTimeBank> = {};
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const [userId, value] of Object.entries(snapshot.players)) {
    if (!uuid.test(userId) || !value || typeof value !== 'object') continue;
    const bank = value as ParkedTimeBank;
    if (
      !uuid.test(bank.occupancyId) ||
      ![
        bank.remainingSeconds,
        bank.usesRemaining,
        bank.initialSeconds,
        bank.baseSeconds,
        bank.dbConsumedSeconds,
      ].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
      !Number.isSafeInteger(bank.usesRemaining) ||
      (bank.unlimitedActivations !== undefined && typeof bank.unlimitedActivations !== 'boolean') ||
      bank.remainingSeconds > bank.initialSeconds ||
      bank.baseSeconds > bank.initialSeconds ||
      bank.dbConsumedSeconds > bank.initialSeconds - bank.baseSeconds
    )
      continue;
    valid[userId] = bank;
  }
  return valid;
}
