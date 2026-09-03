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
