/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LEASE — one tournament, one manager
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE LAST THING STOPPING A SECOND ENGINE INSTANCE.
 *
 * Cash tables have been leased and enforced for a while, and production reports
 * it working: `enforced: true, conflictCount: 0, claimErrors: 0`. Two instances
 * could share the cash fleet today.
 *
 * Tournaments could not. `discoverTournaments()` selects every RUNNING
 * tournament and constructs a TournamentManager for any not already in ITS OWN
 * in-memory map — a check that is meaningless across processes. Start a second
 * container and both would resume the same tournament: two managers advancing
 * blind levels, two calling synchronized breaks, two running hand-for-hand, two
 * processing eliminations and payouts for one event. That is the same class of
 * failure the table lease was built to prevent, described there as "two decks,
 * two dealers and two settlements against the same seats" — worse than an
 * outage, because an outage does not corrupt a prize pool.
 *
 * So this is deliberately a MIRROR of tableLease.ts rather than a new idea:
 * same claim / heartbeat / release shape and same 30s staleness. One pattern
 * to understand, and the table version is already proven.
 *
 * ── OWNERSHIP MUST BE PROVEN WHEN ENFORCEMENT IS ON ─────────────────────────
 *
 * A lease check sits in front of "may I run this tournament", so a bug here
 * could stop every tournament on the platform — the outcome it exists to
 * prevent. Therefore:
 *
 *   - Enforcement is ON by default. Only the exact emergency override
 *     ENGINE_TOURNAMENT_LEASE_ENFORCE === 'off' restores the historical
 *     fail-open behaviour. An absent or misspelled setting must never silently
 *     permit two managers to own the same tournament.
 *   - With enforcement on, an RPC/transport failure is UNKNOWN, never proof
 *     that this process owns the tournament. A new manager stands down and
 *     retries the same causal admission rather than risking two managers.
 *   - The explicit enforcement-off escape hatch retains the historical
 *     fail-open behaviour, but marks the grant unverified so callers and
 *     diagnostics cannot confuse it with database-confirmed ownership.
 *
 * WITH ONE INSTANCE RUNNING, THIS CHANGES NOTHING: every claim is granted to
 * the only claimant. Its value is that the day a second instance starts, the
 * tournaments are already safe.
 */

import { supabase } from './supabase/client.js';
import { INSTANCE_ID, INSTANCE_VERSION } from './tableLease.js';

/** Matches the table lease, and the RPC default. */
export const TOURNAMENT_LEASE_STALE_SECONDS = 30;

export const TOURNAMENT_LEASE_ENFORCED: boolean =
  process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE !== 'off';

export interface TournamentConflict {
  tournamentId: string;
  holder: string | null;
  holderAgeSeconds: number | null;
  at: number;
}

/** Ownership answer for one tournament-manager admission attempt. */
export type TournamentLeaseClaimResult =
  | { status: 'granted'; verified: boolean }
  | { status: 'owned_elsewhere'; conflict: TournamentConflict }
  | {
      status: 'retryable_failure';
      reason: 'rpc_error' | 'rpc_threw' | 'malformed_response';
    };

const conflicts = new Map<string, TournamentConflict>();
let claimErrors = 0;
let heartbeatErrors = 0;
/** Missing/stale heartbeat results — leases nobody took. See heartbeatTournaments. */
let reclaimableHeartbeats = 0;

function unverifiedClaimResult(
  tournamentId: string,
  reason: 'rpc_error' | 'rpc_threw' | 'malformed_response',
  detail: string
): TournamentLeaseClaimResult {
  claimErrors++;
  if (claimErrors <= 3) {
    console.warn(
      `[tournament-lease] claim_tournament_lease ${reason} for ${tournamentId} (${detail}) - ` +
        (TOURNAMENT_LEASE_ENFORCED
          ? 'refusing to run a manager until ownership can be proven'
          : 'proceeding without a verified lease because enforcement is off')
    );
  }
  return TOURNAMENT_LEASE_ENFORCED
    ? { status: 'retryable_failure', reason }
    : { status: 'granted', verified: false };
}

/**
 * Try to take (or renew) one tournament lease without erasing why admission
 * failed. A verified database grant is the only success under enforcement.
 */
export async function claimTournamentLease(
  tournamentId: string
): Promise<TournamentLeaseClaimResult> {
  try {
    const { data, error } = await supabase.rpc('claim_tournament_lease', {
      p_tournament_id: tournamentId,
      p_instance_id: INSTANCE_ID,
      p_version: INSTANCE_VERSION,
      p_stale_seconds: TOURNAMENT_LEASE_STALE_SECONDS,
    });
    if (error) {
      return unverifiedClaimResult(
        tournamentId,
        'rpc_error',
        String(error.message || 'unknown error')
      );
    }

    // The RPC RETURNS TABLE, so PostgREST normally returns exactly one row.
    // Accept the equivalent direct-object shape used by test/local adapters,
    // but never guess ownership from an empty, multi-row or untyped payload.
    const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
    if (
      !row ||
      typeof row !== 'object' ||
      typeof (row as { granted?: unknown }).granted !== 'boolean'
    ) {
      return unverifiedClaimResult(
        tournamentId,
        'malformed_response',
        'response did not contain one boolean granted discriminator'
      );
    }

    const leaseRow = row as {
      granted: boolean;
      holder?: unknown;
      holder_age_seconds?: unknown;
    };
    if (leaseRow.granted) {
      conflicts.delete(tournamentId);
      return { status: 'granted', verified: true };
    }

    const rawAge = leaseRow.holder_age_seconds;
    const numericAge = rawAge === null || rawAge === undefined ? null : Number(rawAge);
    const conflict: TournamentConflict = {
      tournamentId,
      holder: typeof leaseRow.holder === 'string' ? leaseRow.holder : null,
      holderAgeSeconds: numericAge !== null && Number.isFinite(numericAge) ? numericAge : null,
      at: Date.now(),
    };
    conflicts.set(tournamentId, conflict);
    console.warn(
      `[tournament-lease] ${tournamentId} is held by ${conflict.holder}` +
        (TOURNAMENT_LEASE_ENFORCED ? '. Standing down.' : ' (enforcement off; running it anyway).')
    );
    return TOURNAMENT_LEASE_ENFORCED
      ? { status: 'owned_elsewhere', conflict }
      : { status: 'granted', verified: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return unverifiedClaimResult(tournamentId, 'rpc_threw', detail);
  }
}

/**
 * Boolean compatibility adapter for existing discovery. New admission code
 * should consume claimTournamentLease() so a transient ownership failure can
 * retain its exact causal retry instead of looking like a foreign owner.
 */
export async function claimTournament(tournamentId: string): Promise<boolean> {
  return (await claimTournamentLease(tournamentId)).status === 'granted';
}

/**
 * Renew every tournament lease this instance believes it holds.
 *
 * @returns the subset it has LOST. Empty on any error, because "we could not
 *          ask" must never be read as "we lost everything" — that inversion is
 *          how a fail-safe becomes an outage.
 */
export async function heartbeatTournaments(tournamentIds: string[]): Promise<string[]> {
  if (tournamentIds.length === 0) return [];
  try {
    const { data, error } = await supabase.rpc('heartbeat_tournament_leases_v2', {
      p_instance_id: INSTANCE_ID,
      p_tournament_ids: tournamentIds,
      p_stale_seconds: TOURNAMENT_LEASE_STALE_SECONDS,
    });
    if (error) {
      heartbeatErrors++;
      if (heartbeatErrors <= 3) {
        console.warn(`[tournament-lease] heartbeat failed (${error.message}) - keeping every one`);
      }
      return [];
    }

    const rows = (data ?? []) as Array<{ tournament_id: string; state: string }>;
    const stateOf = new Map(rows.map((r) => [r.tournament_id, r.state]));
    const taken: string[] = [];
    let reclaimable = 0;

    for (const id of tournamentIds) {
      // Silence is not evidence of a takeover. See tableLease.heartbeatTables.
      const state = stateOf.get(id) ?? 'missing';
      if (state === 'kept') continue;
      if (state === 'taken') {
        taken.push(id);
        console.warn(
          `[tournament-lease] ${id} is held by another LIVE instance` +
            (TOURNAMENT_LEASE_ENFORCED ? '. Stopping it here.' : ' (enforcement off; continuing).')
        );
        continue;
      }
      reclaimable++;
    }

    if (reclaimable > 0) {
      reclaimableHeartbeats += reclaimable;
      console.warn(
        `[tournament-lease] ${reclaimable} of ${tournamentIds.length} leases were missing or stale, not taken - re-claiming, still running`
      );
    }

    return TOURNAMENT_LEASE_ENFORCED ? taken : [];
  } catch (err) {
    heartbeatErrors++;
    if (heartbeatErrors <= 3) {
      console.warn(
        `[tournament-lease] heartbeat threw (${(err as Error)?.message}) - keeping every one`
      );
    }
    return [];
  }
}

/** Hand leases back on the way out, so a redeploy does not wait out 30s. */
export async function releaseTournaments(tournamentIds?: string[]): Promise<void> {
  try {
    await supabase.rpc('release_tournament_leases', {
      p_instance_id: INSTANCE_ID,
      p_tournament_ids: tournamentIds ?? null,
    });
  } catch {
    // Shutdown path: a failure here costs at most one stale window.
  }
}

/** For /health, mirroring leaseDiagnostics(). */
export function tournamentLeaseDiagnostics() {
  return {
    instanceId: INSTANCE_ID,
    enforced: TOURNAMENT_LEASE_ENFORCED,
    conflictCount: conflicts.size,
    claimErrors,
    heartbeatErrors,
    reclaimableHeartbeats,
    conflicts: [...conflicts.values()],
  };
}
