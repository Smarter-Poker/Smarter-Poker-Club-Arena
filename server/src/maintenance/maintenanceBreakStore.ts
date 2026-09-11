/**
 * The durable half of the maintenance break: one row in
 * `engine_maintenance_break` that outlives the process which wrote it.
 *
 * See supabase/migrations/20260902080000_maintenance_break_survives_the_restart.sql
 * for why this is its own row rather than `tables.status = 'paused'` (that
 * value exists, and writing it makes `cash_tables_needing_engine` abandon the
 * table instead of pausing it).
 */

import { maintenanceSupabase } from '../services/supabase.js';
import type { MaintenanceBreakStore, PersistedMaintenanceBreak } from './MaintenanceBreak.js';

const TABLE = 'engine_maintenance_break';

type MaintenanceBreakRow = {
  phase?: unknown;
  announced_at?: unknown;
  break_started_at?: unknown;
  break_ends_at?: unknown;
  reason?: unknown;
  ownership_token?: unknown;
};

function parseTimestamp(value: unknown, field: string, nullable: true): number | null;
function parseTimestamp(value: unknown, field: string, nullable?: false): number;
function parseTimestamp(value: unknown, field: string, nullable = false): number | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') throw new Error(`maintenance_break_invalid_${field}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`maintenance_break_invalid_${field}`);
  return parsed;
}

/** Reject malformed durable authority rather than turning NaN into an immediate resume. */
export function decodeMaintenanceBreakRow(raw: MaintenanceBreakRow): PersistedMaintenanceBreak {
  if (raw.phase !== 'last_hand' && raw.phase !== 'counting_down') {
    throw new Error('maintenance_break_invalid_phase');
  }
  const announcedAt = parseTimestamp(raw.announced_at, 'announced_at');
  const breakStartedAt = parseTimestamp(raw.break_started_at, 'break_started_at', true);
  const breakEndsAt = parseTimestamp(raw.break_ends_at, 'break_ends_at', true);
  if (typeof raw.reason !== 'string' || raw.reason.trim().length === 0) {
    throw new Error('maintenance_break_invalid_reason');
  }
  if (
    typeof raw.ownership_token !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      raw.ownership_token
    )
  ) {
    throw new Error('maintenance_break_invalid_ownership_token');
  }
  if (raw.phase === 'last_hand' && (breakStartedAt !== null || breakEndsAt !== null)) {
    throw new Error('maintenance_break_invalid_last_hand_shape');
  }
  if (
    raw.phase === 'counting_down' &&
    (breakStartedAt === null ||
      breakEndsAt === null ||
      breakStartedAt < announcedAt ||
      breakEndsAt <= breakStartedAt ||
      breakEndsAt >= announcedAt + 15 * 60_000)
  ) {
    throw new Error('maintenance_break_invalid_countdown_shape');
  }
  return {
    phase: raw.phase,
    announcedAt,
    breakStartedAt,
    breakEndsAt,
    reason: raw.reason,
    ownershipToken: raw.ownership_token,
  };
}

/** Decode the narrow scalar RPC without ever treating malformed time as idle. */
export function decodeMaintenanceReleaseBoundary(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  return parseTimestamp(raw, 'release_boundary');
}

export function createSupabaseMaintenanceBreakStore(version?: string): MaintenanceBreakStore {
  return {
    async load(): Promise<PersistedMaintenanceBreak | null> {
      // .maybeSingle() per CLAUDE.md rule 5.1 - the common case is no row at
      // all, and .single() throws PGRST116 on zero rows, which on this path
      // would make every ordinary boot log an error.
      // Use the same short, no-hidden-retry transport as writes. Boot and
      // ambiguous-write receipt recovery are part of shutdown ownership and
      // must fit comfortably inside the process's 40-second hard deadline.
      const { data, error } = await maintenanceSupabase
        .from(TABLE)
        .select('phase, announced_at, break_started_at, break_ends_at, reason, ownership_token')
        .eq('id', true)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) return null;

      return decodeMaintenanceBreakRow(data);
    },

    async loadReleaseBoundary(): Promise<number | null> {
      const { data, error } = await maintenanceSupabase.rpc(
        'fn_active_maintenance_release_boundary'
      );
      if (error) throw new Error(error.message);
      return decodeMaintenanceReleaseBoundary(data);
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
      return decodeMaintenanceBreakRow(data);
    },

    async save(state: PersistedMaintenanceBreak): Promise<void> {
      /* This RPC takes the exclusive maintenance advisory lock as its first
         database statement and has a six-second ceiling. A blocked :53 write
         fails quickly and is retried by MaintenanceBreak until the fixed :55
         boundary; no single request can outlive process ownership. */
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
