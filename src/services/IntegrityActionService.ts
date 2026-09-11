/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INTEGRITY ACTIONS — removing a player from play, through the engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03)
 *
 * The Anti-Cheat console's "Kick" stamped `left_at` and status 'kicked' onto
 * `table_seats` from the browser. That is the write CLAUDE.md 11.5 exists to
 * forbid: closing a seat outside a cash-out destroys the stack sitting in it,
 * and the `ca_seat_stack_exits` trigger files every such exit into
 * `ledger_reconcile_log` as critical. It also never had a table id - every call
 * site passed a player and nothing else - so the seat branch was skipped
 * entirely, the compensating `anti_cheat_events` insert was refused by RLS
 * (service-role only), and the operator was told "Player removed."
 *
 * The engine has done this correctly since Round 68. `POST /admin/kick`
 * authorizes the caller as a club admin from their own bearer token, auto-folds
 * a player who is mid-hand, cashes the stack out between hands through
 * `atomic_seat_cashout_locked`, and writes the audit row itself. This module is
 * the client half, and the only sanctioned way for an operator surface to
 * remove somebody from a table.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';
import type { SeatOccupancyTarget } from './SeatLeaveIntent';

export interface RemovalOutcome {
  removed: number;
  pending: number;
  failed: number;
  /** The first refusal, so the operator is told why rather than just a count. */
  firstError: string | null;
}

/** Remove one player from one table. Resolves false with the reason on refusal. */
export async function adminRemovePlayerFromTable(
  tableId: string,
  userId: string,
  reason: string,
  target?: SeatOccupancyTarget
): Promise<{ ok: boolean; error: string | null; deferred?: boolean }> {
  try {
    const { kickSeatWithIntent } = await import('./SeatLeaveIntent');
    const result = await kickSeatWithIntent(tableId, userId, reason, target);
    if (!result.success)
      return { ok: false, error: result.error || 'The Engine Refused This Removal.' };
    masterBus.emit('TABLE_UPDATED', { tableId, status: 'running' });
    return { ok: true, error: null, deferred: result.deferred === true };
  } catch (error) {
    reportError(error, 'IntegrityActionService.Remove_failed');
    return { ok: false, error: 'The engine could not be reached.' };
  }
}

/**
 * Remove one player from every table they are seated at in this club. Partial
 * success is reported as partial success: an operator who removed a player from
 * three of four tables must not be told the job is done.
 */
/**
 * The tables in this club where a player is currently sitting.
 *
 * Lifted out of AntiCheatPage in phase 3, when the agent console needed the
 * same three lines to remove an excluded player. A seat is live while
 * `left_at` is null; this only reads, and the removal itself is still the
 * engine's, because closing a seat from the browser destroys the stack in it
 * (CLAUDE.md 11.5).
 */
export async function liveSeatTableIds(clubUUID: string, userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('table_seats')
    .select('table_id, tables!table_seats_table_id_fkey!inner(club_id)')
    .eq('user_id', userId)
    .is('left_at', null)
    .eq('tables.club_id', clubUUID);
  if (error) throw error;
  return [...new Set(((data || []) as Array<{ table_id: string }>).map((r) => r.table_id))];
}

export async function adminRemovePlayerFromClubTables(
  tableIds: string[],
  userId: string,
  reason: string
): Promise<RemovalOutcome> {
  let removed = 0;
  let pending = 0;
  let failed = 0;
  let firstError: string | null = null;

  // Freeze every target before the first asynchronous departure. A replacement
  // seat appearing while another table's removal waits is never part of this action.
  const targets = await Promise.all(
    [...new Set(tableIds)].map(async (tableId) => {
      try {
        const { data, error } = await supabase
          .from('table_seats')
          .select('seat_number, occupancy_id')
          .eq('table_id', tableId)
          .eq('user_id', userId)
          .is('left_at', null)
          .maybeSingle();
        if (error || !data) return { tableId, error: 'The Original Seat Could Not Be Read.' };
        return {
          tableId,
          target: { seatNumber: data.seat_number, occupancyId: data.occupancy_id },
        };
      } catch {
        return { tableId, error: 'The Original Seat Could Not Be Read.' };
      }
    })
  );
  for (const selected of targets) {
    const outcome = selected.target
      ? await adminRemovePlayerFromTable(selected.tableId, userId, reason, selected.target)
      : { ok: false, error: selected.error };

    if (outcome.ok) {
      if (outcome.deferred) pending += 1;
      else removed += 1;
    } else {
      failed += 1;
      if (!firstError) firstError = outcome.error;
    }
  }

  return { removed, pending, failed, firstError };
}
