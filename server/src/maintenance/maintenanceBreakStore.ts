/**
 * The durable half of the maintenance break: one row in
 * `engine_maintenance_break` that outlives the process which wrote it.
 *
 * See supabase/migrations/20260902080000_maintenance_break_survives_the_restart.sql
 * for why this is its own row rather than `tables.status = 'paused'` (that
 * value exists, and writing it makes `cash_tables_needing_engine` abandon the
 * table instead of pausing it).
 */

import { maintenanceSupabase, supabase } from '../services/supabase.js';
import { bindToProcessRoot } from '../services/supabase/dataActorContext.js';
import type { MaintenanceBreakStore, PersistedMaintenanceBreak } from './MaintenanceBreak.js';

const TABLE = 'engine_maintenance_break';

export function createSupabaseMaintenanceBreakStore(version?: string): MaintenanceBreakStore {
  return {
    loadReleaseBoundary: bindToProcessRoot(async (): Promise<number | null> => {
      const { data, error } = await maintenanceSupabase.rpc(
        'fn_active_maintenance_release_boundary'
      );
      if (error) throw new Error(error.message);
      if (data === null) return null;
      if (typeof data !== 'string' || !Number.isFinite(Date.parse(data))) {
        throw new Error('maintenance_release_boundary_response_invalid');
      }
      return Date.parse(data);
    }),
    async load(): Promise<PersistedMaintenanceBreak | null> {
      // .maybeSingle() per CLAUDE.md rule 5.1 - the common case is no row at
      // all, and .single() throws PGRST116 on zero rows, which on this path
      // would make every ordinary boot log an error.
      const { data, error } = await supabase
        .from(TABLE)
        .select('phase, announced_at, break_started_at, break_ends_at, reason, ownership_token')
        .eq('id', true)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) return null;

      return {
        phase: data.phase as PersistedMaintenanceBreak['phase'],
        announcedAt: Date.parse(data.announced_at),
        breakStartedAt: data.break_started_at ? Date.parse(data.break_started_at) : null,
        breakEndsAt: data.break_ends_at ? Date.parse(data.break_ends_at) : null,
        reason: data.reason,
        ownershipToken: data.ownership_token,
      };
    },

    async claim(
      expectedOwnershipToken: string,
      newOwnershipToken: string
    ): Promise<PersistedMaintenanceBreak | null> {
      const { data, error } = await maintenanceSupabase.rpc('fn_claim_engine_maintenance_break', {
        p_expected_ownership_token: expectedOwnershipToken,
        p_new_ownership_token: newOwnershipToken,
        p_declared_by: version ?? null,
      });
      if (error) throw new Error(error.message);
      if (!data?.ok) return null;
      return {
        phase: data.phase as PersistedMaintenanceBreak['phase'],
        announcedAt: Date.parse(data.announced_at),
        breakStartedAt: data.break_started_at ? Date.parse(data.break_started_at) : null,
        breakEndsAt: data.break_ends_at ? Date.parse(data.break_ends_at) : null,
        reason: data.reason,
        ownershipToken: data.ownership_token,
      };
    },

    async save(state: PersistedMaintenanceBreak): Promise<void> {
      /* This RPC takes the exclusive maintenance advisory lock as its first
         database statement and has a 45-second database ceiling. Its dedicated
         client waits 50 seconds, so an already-admitted 30-second purchase can
         commit before the announcement without making the hour disappear. */
      const { error } = await maintenanceSupabase.rpc('fn_save_engine_maintenance_break', {
        p_phase: state.phase,
        p_announced_at: new Date(state.announcedAt).toISOString(),
        // The REAL countdown start, not "now": an engine adopting a break
        // half-way through must not shrink the frozen duration the thaw
        // will later measure from this instant.
        p_break_started_at: state.breakStartedAt
          ? new Date(state.breakStartedAt).toISOString()
          : null,
        p_break_ends_at: state.breakEndsAt ? new Date(state.breakEndsAt).toISOString() : null,
        p_reason: state.reason,
        p_declared_by: version ?? null,
        p_ownership_token: state.ownershipToken,
      });
      if (error) throw new Error(error.message);
    },

    async clear(expected: PersistedMaintenanceBreak): Promise<void> {
      const { error } = await maintenanceSupabase.rpc('fn_clear_engine_maintenance_break', {
        p_phase: expected.phase,
        p_announced_at: new Date(expected.announcedAt).toISOString(),
        p_break_started_at: expected.breakStartedAt
          ? new Date(expected.breakStartedAt).toISOString()
          : null,
        p_break_ends_at: expected.breakEndsAt ? new Date(expected.breakEndsAt).toISOString() : null,
        p_reason: expected.reason,
        p_ownership_token: expected.ownershipToken,
      });
      if (error) throw new Error(error.message);
    },
  };
}
