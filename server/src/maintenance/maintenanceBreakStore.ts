/**
 * The durable half of the maintenance break: one row in
 * `engine_maintenance_break` that outlives the process which wrote it.
 *
 * See supabase/migrations/20260902080000_maintenance_break_survives_the_restart.sql
 * for why this is its own row rather than `tables.status = 'paused'` (that
 * value exists, and writing it makes `cash_tables_needing_engine` abandon the
 * table instead of pausing it).
 */

import { supabase } from '../services/supabase.js';
import type { MaintenanceBreakStore, PersistedMaintenanceBreak } from './MaintenanceBreak.js';

const TABLE = 'engine_maintenance_break';

export function createSupabaseMaintenanceBreakStore(version?: string): MaintenanceBreakStore {
  return {
    async load(): Promise<PersistedMaintenanceBreak | null> {
      // .maybeSingle() per CLAUDE.md rule 5.1 - the common case is no row at
      // all, and .single() throws PGRST116 on zero rows, which on this path
      // would make every ordinary boot log an error.
      const { data, error } = await supabase
        .from(TABLE)
        .select('phase, announced_at, break_started_at, break_ends_at, reason')
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
      };
    },

    async save(state: PersistedMaintenanceBreak): Promise<void> {
      // Upsert on the pinned primary key: the announcement INSERTs, and the
      // countdown five minutes later UPDATEs the same row in place. Two rows
      // would mean two contradictory breaks, which the boolean primary key
      // makes impossible by construction.
      const { error } = await supabase.from(TABLE).upsert(
        {
          id: true,
          phase: state.phase,
          announced_at: new Date(state.announcedAt).toISOString(),
          // The REAL countdown start, not "now": an engine adopting a break
          // half-way through must not shrink the frozen duration the thaw
          // will later measure from this instant.
          break_started_at: state.breakStartedAt
            ? new Date(state.breakStartedAt).toISOString()
            : null,
          // Arms the Postgres-side freeze (zz_freeze_guard triggers and the
          // pg_cron early returns). Only this engine build writes it, which
          // is what keeps the freeze inert while an older engine - one that
          // could still deal a hand mid-break - is the one declaring breaks.
          enforce_freeze: true,
          break_ends_at: state.breakEndsAt ? new Date(state.breakEndsAt).toISOString() : null,
          reason: state.reason,
          declared_by: version ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (error) throw new Error(error.message);
    },

    async clear(): Promise<void> {
      const { error } = await supabase.from(TABLE).delete().eq('id', true);
      if (error) throw new Error(error.message);
    },
  };
}
