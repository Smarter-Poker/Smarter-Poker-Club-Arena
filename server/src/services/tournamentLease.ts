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
 *   - Enforcement is unconditional. No production environment switch can
 *     authorize a generation-less tournament manager.
 *   - An RPC/transport failure is UNKNOWN, never proof
 *     that this process owns the tournament. A new manager stands down and
 *     retries the same causal admission rather than risking two managers.
 *
 * WITH ONE INSTANCE RUNNING, THIS CHANGES NOTHING: every claim is granted to
 * the only claimant. Its value is that the day a second instance starts, the
 * tournaments are already safe.
 */

import { supabase } from './supabase/client.js';
import { INSTANCE_ID, INSTANCE_VERSION } from './tableLease.js';

/** Matches the table lease, and the RPC default. */
export const TOURNAMENT_LEASE_STALE_SECONDS = 30;

/**
 * A local owner stops ten seconds before another database claimant may take
 * over. The deadline is anchored to the monotonic instant BEFORE the RPC, so
 * network latency can only shorten authority; it can never move the local
 * deadline past the database heartbeat written during that request.
 */
export const TOURNAMENT_LEASE_PROOF_WINDOW_MS = 20_000;

let monotonicNow: () => number = () => performance.now();

export function tournamentLeaseMonotonicNow(): number {
  return monotonicNow();
}

/** Test seam for deterministic expiry/event-loop-delay regressions. */
export function _setTournamentLeaseMonotonicNowForTests(now?: () => number): void {
  monotonicNow = now ?? (() => performance.now());
}

export const TOURNAMENT_LEASE_ENFORCED: true = true;

export interface TournamentConflict {
  tournamentId: string;
  holder: string | null;
  holderAgeSeconds: number | null;
  at: number;
}

/** Ownership answer for one tournament-manager admission attempt. */
export type TournamentLeaseClaimResult =
  | {
      status: 'granted';
      verified: true;
      leaseGeneration: string;
      proofDeadlineMonotonicMs: number;
    }
  | {
      status: 'acquired_but_proof_expired';
      leaseGeneration: string;
    }
  | { status: 'owned_elsewhere'; conflict: TournamentConflict }
  | {
      status: 'retryable_failure';
      reason: 'rpc_error' | 'rpc_threw' | 'malformed_response';
      requestedGeneration: string;
      mayHaveCommitted: boolean;
    };

const conflicts = new Map<string, TournamentConflict>();
let claimErrors = 0;
let heartbeatErrors = 0;
/** Legacy health counter: successful heartbeats that proved the row was gone. */
let reclaimableHeartbeats = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TournamentLeaseHeartbeatClaim {
  tournamentId: string;
  leaseGeneration: string;
}

export type TournamentLeaseReleaseOutcome =
  | { status: 'confirmed'; releasedCount: number; attempts: number }
  | {
      status: 'uncertain';
      reason: 'invalid_claims' | 'rpc_error' | 'rpc_threw' | 'malformed_response';
      detail: string;
      attempts: number;
    };

const LEASE_RELEASE_MAX_ATTEMPTS = 2;

export interface TournamentLeaseHeartbeatProof extends TournamentLeaseHeartbeatClaim {
  proofDeadlineMonotonicMs: number;
}

export type TournamentLeaseHeartbeatOutcome =
  | {
      status: 'answered';
      proofs: TournamentLeaseHeartbeatProof[];
      /** Exact-generation successes whose own conservative window has elapsed. */
      obsoleteProofs?: TournamentLeaseHeartbeatProof[];
      lostTournamentIds: string[];
    }
  | {
      status: 'uncertain';
      reason: 'rpc_error' | 'rpc_threw';
    };

function unverifiedClaimResult(
  tournamentId: string,
  requestedGeneration: string,
  mayHaveCommitted: boolean,
  reason: 'rpc_error' | 'rpc_threw' | 'malformed_response',
  detail: string
): TournamentLeaseClaimResult {
  claimErrors++;
  if (claimErrors <= 3) {
    console.warn(
      `[tournament-lease] claim_tournament_lease ${reason} for ${tournamentId} (${detail}) - ` +
        'refusing to run a manager until ownership can be proven'
    );
  }
  return { status: 'retryable_failure', reason, requestedGeneration, mayHaveCommitted };
}

/**
 * Try to take (or renew) one tournament lease without erasing why admission
 * failed. A verified database grant is the only success under enforcement.
 */
export async function claimTournamentLease(
  tournamentId: string,
  requestedGeneration: string
): Promise<TournamentLeaseClaimResult> {
  if (!UUID_PATTERN.test(requestedGeneration)) {
    return unverifiedClaimResult(
      tournamentId,
      requestedGeneration,
      false,
      'malformed_response',
      'caller supplied an invalid requested generation'
    );
  }
  const proofDeadlineMonotonicMs = tournamentLeaseMonotonicNow() + TOURNAMENT_LEASE_PROOF_WINDOW_MS;
  try {
    const { data, error } = await supabase.rpc('claim_tournament_lease_v2', {
      p_tournament_id: tournamentId,
      p_instance_id: INSTANCE_ID,
      p_version: INSTANCE_VERSION,
      p_requested_generation: requestedGeneration,
      p_stale_seconds: TOURNAMENT_LEASE_STALE_SECONDS,
    });
    if (error) {
      return unverifiedClaimResult(
        tournamentId,
        requestedGeneration.toLowerCase(),
        true,
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
        requestedGeneration.toLowerCase(),
        true,
        'malformed_response',
        'response did not contain one boolean granted discriminator'
      );
    }

    const leaseRow = row as {
      granted: boolean;
      holder?: unknown;
      holder_age_seconds?: unknown;
      lease_generation?: unknown;
      protocol_version?: unknown;
    };
    if (leaseRow.granted) {
      if (
        typeof leaseRow.lease_generation !== 'string' ||
        !UUID_PATTERN.test(leaseRow.lease_generation) ||
        leaseRow.lease_generation.toLowerCase() !== requestedGeneration.toLowerCase() ||
        leaseRow.protocol_version !== 2
      ) {
        return unverifiedClaimResult(
          tournamentId,
          requestedGeneration.toLowerCase(),
          true,
          'malformed_response',
          'a granted response did not prove the exact requested protocol-2 generation'
        );
      }
      if (tournamentLeaseMonotonicNow() >= proofDeadlineMonotonicMs) {
        claimErrors++;
        return {
          status: 'acquired_but_proof_expired',
          leaseGeneration: leaseRow.lease_generation.toLowerCase(),
        };
      }
      conflicts.delete(tournamentId);
      return {
        status: 'granted',
        verified: true,
        leaseGeneration: leaseRow.lease_generation.toLowerCase(),
        proofDeadlineMonotonicMs,
      };
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
      `[tournament-lease] ${tournamentId} is held by ${conflict.holder}. Standing down.`
    );
    return { status: 'owned_elsewhere', conflict };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return unverifiedClaimResult(
      tournamentId,
      requestedGeneration.toLowerCase(),
      true,
      'rpc_threw',
      detail
    );
  }
}

/**
 * Renew every tournament lease this instance believes it holds.
 *
 * A transport failure is typed UNKNOWN and does not extend authority. The
 * manager continues only until its previously proven monotonic deadline. A
 * successful response proves each exact generation and advances its deadline
 * from the instant before this RPC began. A busy exact generation extends
 * nothing; the existing proof deadline and expiry timer remain authoritative.
 */
export async function heartbeatTournaments(
  claims: TournamentLeaseHeartbeatClaim[]
): Promise<TournamentLeaseHeartbeatOutcome> {
  if (claims.length === 0) {
    return { status: 'answered', proofs: [], lostTournamentIds: [] };
  }
  const tournamentIds = claims.map((claim) => claim.tournamentId);
  const proofDeadlineMonotonicMs = tournamentLeaseMonotonicNow() + TOURNAMENT_LEASE_PROOF_WINDOW_MS;
  try {
    const { data, error } = await supabase.rpc('heartbeat_tournament_leases_v4', {
      p_instance_id: INSTANCE_ID,
      p_claims: claims.map((claim) => ({
        tournament_id: claim.tournamentId,
        lease_generation: claim.leaseGeneration,
      })),
      p_stale_seconds: TOURNAMENT_LEASE_STALE_SECONDS,
    });
    if (error) {
      heartbeatErrors++;
      if (heartbeatErrors <= 3) {
        console.warn(
          `[tournament-lease] heartbeat failed (${error.message}) - retaining only the prior proof window`
        );
      }
      return { status: 'uncertain', reason: 'rpc_error' };
    }

    const rawRows = Array.isArray(data) ? data : null;
    const expectedIds = new Set(tournamentIds);
    const rowsById = new Map<
      string,
      { state: 'kept' | 'taken' | 'stale' | 'missing' | 'busy'; leaseGeneration: unknown }
    >();
    let malformed = rawRows === null || rawRows.length !== claims.length;
    for (const candidate of rawRows ?? []) {
      if (!candidate || typeof candidate !== 'object') {
        malformed = true;
        continue;
      }
      const row = candidate as {
        tournament_id?: unknown;
        state?: unknown;
        lease_generation?: unknown;
      };
      if (
        typeof row.tournament_id !== 'string' ||
        !expectedIds.has(row.tournament_id) ||
        !['kept', 'taken', 'stale', 'missing', 'busy'].includes(String(row.state)) ||
        rowsById.has(row.tournament_id)
      ) {
        malformed = true;
        continue;
      }
      rowsById.set(row.tournament_id, {
        state: row.state as 'kept' | 'taken' | 'stale' | 'missing' | 'busy',
        leaseGeneration: row.lease_generation,
      });
    }

    if (malformed || rowsById.size !== claims.length) {
      heartbeatErrors++;
      if (heartbeatErrors <= 3) {
        console.warn(
          '[tournament-lease] heartbeat returned an incomplete or malformed generation proof'
        );
      }
      return { status: 'answered', proofs: [], lostTournamentIds: tournamentIds };
    }

    const proofs: TournamentLeaseHeartbeatProof[] = [];
    const obsoleteProofs: TournamentLeaseHeartbeatProof[] = [];
    const lostTournamentIds: string[] = [];
    for (const claim of claims) {
      const row = rowsById.get(claim.tournamentId)!;
      const exactGeneration =
        typeof row.leaseGeneration === 'string' &&
        row.leaseGeneration.toLowerCase() === claim.leaseGeneration.toLowerCase();
      if (row.state === 'kept' && exactGeneration) {
        const proof = { ...claim, proofDeadlineMonotonicMs };
        // A slow older success is not a takeover. It grants no authority when
        // obsolete; the owner separately checks its greatest existing proof.
        if (tournamentLeaseMonotonicNow() < proofDeadlineMonotonicMs) proofs.push(proof);
        else obsoleteProofs.push(proof);
        continue;
      }

      // A locked exact generation is UNKNOWN, never a renewal. GameServer
      // checks the existing monotonic deadline after this response and its
      // ordinary expiry timer remains armed throughout repeated busy replies.
      if (row.state === 'busy' && exactGeneration) continue;

      lostTournamentIds.push(claim.tournamentId);
      if (row.state === 'missing' || row.state === 'stale') reclaimableHeartbeats++;
      console.warn(
        `[tournament-lease] ${claim.tournamentId} no longer proves lease generation ${claim.leaseGeneration}. Stopping it here.`
      );
    }

    return {
      status: 'answered',
      proofs,
      lostTournamentIds,
      ...(obsoleteProofs.length > 0 ? { obsoleteProofs } : {}),
    };
  } catch (err) {
    heartbeatErrors++;
    if (heartbeatErrors <= 3) {
      console.warn(
        `[tournament-lease] heartbeat threw (${(err as Error)?.message}) - retaining only the prior proof window`
      );
    }
    return { status: 'uncertain', reason: 'rpc_threw' };
  }
}

/**
 * Hand exact generations back on the way out. Confirmed zero means the exact
 * row was already absent; uncertainty is returned so shutdown cannot issue a
 * false success certificate and force the replacement to wait out 30 seconds.
 */
export async function releaseTournaments(
  claims: TournamentLeaseHeartbeatClaim[] = []
): Promise<TournamentLeaseReleaseOutcome> {
  if (claims.length === 0) {
    return { status: 'confirmed', releasedCount: 0, attempts: 0 };
  }
  if (
    new Set(claims.map((claim) => claim.tournamentId)).size !== claims.length ||
    claims.some(
      (claim) => !UUID_PATTERN.test(claim.tournamentId) || !UUID_PATTERN.test(claim.leaseGeneration)
    )
  ) {
    return {
      status: 'uncertain',
      reason: 'invalid_claims',
      detail: 'release requires unique tournament ids and one valid generation per tournament',
      attempts: 0,
    };
  }
  let lastFailure: Exclude<TournamentLeaseReleaseOutcome, { status: 'confirmed' }> = {
    status: 'uncertain',
    reason: 'rpc_threw',
    detail: 'release did not run',
    attempts: 0,
  };
  const payload = {
    p_instance_id: INSTANCE_ID,
    p_claims: claims.map((claim) => ({
      tournament_id: claim.tournamentId,
      lease_generation: claim.leaseGeneration,
    })),
  };
  for (let attempt = 1; attempt <= LEASE_RELEASE_MAX_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await supabase.rpc('release_tournament_leases_v2', payload);
      if (error) {
        lastFailure = {
          status: 'uncertain',
          reason: 'rpc_error',
          detail: String(error.message || 'unknown release error'),
          attempts: attempt,
        };
        continue;
      }
      if (
        typeof data !== 'number' ||
        !Number.isSafeInteger(data) ||
        data < 0 ||
        data > claims.length
      ) {
        lastFailure = {
          status: 'uncertain',
          reason: 'malformed_response',
          detail: 'release did not return a bounded integer deletion count',
          attempts: attempt,
        };
        continue;
      }
      return { status: 'confirmed', releasedCount: data, attempts: attempt };
    } catch (error) {
      lastFailure = {
        status: 'uncertain',
        reason: 'rpc_threw',
        detail: error instanceof Error ? error.message : String(error),
        attempts: attempt,
      };
    }
  }
  return lastFailure;
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
