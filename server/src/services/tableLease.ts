/**
 * ═══════════════════════════════════════════════════════════════════════════
 * tableLease — one engine instance per table, arbitrated by the database
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY (2026-08-16 incident, 00:38:45 -> 01:09:11 UTC)
 *
 * Two engine containers served engine.smarter.poker simultaneously: the build
 * from PR #72 and a rolled-back `13a90cf4` image that the host's recovery paths
 * kept resurrecting from `club-arena-engine:current`. Every table stopped
 * dealing for thirty minutes.
 *
 * Two separate holes made that possible and this module closes both:
 *
 *   1. NOTHING IDENTIFIED A PROCESS. `/health`, `/` and `/metrics` returned
 *      wildly different table counts and uptimes and there was no field that
 *      said which container answered. Diagnosing it took an hour of inference
 *      from hand-history side effects. `instanceId` fixes that.
 *
 *   2. NOTHING OWNED A TABLE. Both containers ran the same discovery query, so
 *      both were entitled to start an engine for the same table id. Two engines
 *      on one table means two decks, two dealers and two settlements against
 *      the same seats — a correctness failure far worse than an outage.
 *
 * ── OWNERSHIP MUST BE PROVEN WHEN ENFORCEMENT IS ON ─────────────────────────
 *
 * A lease check sits directly in front of "may I deal this table", so a bug
 * here could freeze the entire platform — the exact outcome it exists to
 * prevent. Two rules keep that from happening:
 *
 *   - Enforcement is unconditional. A runtime environment switch cannot
 *     authorize a second dealer when the database did not prove ownership.
 *
 *   - With enforcement on, a claim RPC failure is `retryable_failure`, never a
 *     grant. Starting a second dealer because ownership could not be checked is
 *     a split-brain correctness failure, not a liveness recovery.
 *
 *   - An unreadable or malformed ownership answer always fails closed. The
 *     only safe recovery is an exact causal retry with the same requested
 *     generation, never an unleased dealer.
 */

import { randomUUID } from 'node:crypto';
// Straight from the client module, never the `supabase.js` barrel: the barrel
// re-exports every submodule, so importing it from here would pull the whole
// data layer into the module graph for one rpc() call.
import { supabase } from './supabase/client.js';

/**
 * Per-process identity. Regenerated on every boot on purpose: a restarted
 * engine must not inherit the lease rows its own previous incarnation left
 * behind, or a crash-looping container would keep handing tables back to
 * itself and the stale-lease timeout would never do its job.
 */
export const INSTANCE_ID: string = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** The build this process is running, for humans reading the lease table. */
export const INSTANCE_VERSION: string =
  process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local';

/**
 * How long a lease survives without a heartbeat. Must comfortably exceed the
 * discovery interval (5s) so an ordinary slow tick never looks like death, and
 * stay well under the time a human would notice a table not starting.
 */
export const LEASE_STALE_SECONDS = 30;

/**
 * A verified dealer expires locally ten seconds before its database row is
 * eligible for takeover. This is anchored before each RPC starts, so network
 * latency and event-loop delay can only shorten authority, never extend it
 * beyond the 30-second database boundary.
 */
export const TABLE_LEASE_PROOF_WINDOW_MS = 20_000;

let monotonicNow: () => number = () => performance.now();

export function tableLeaseMonotonicNow(): number {
  return monotonicNow();
}

/** Test seam for deterministic event-loop-delay and expiry regressions. */
export function _setTableLeaseMonotonicNowForTests(now?: () => number): void {
  monotonicNow = now ?? (() => performance.now());
}

/**
 * Enforcement is permanently ON as of 2026-09-08. The earlier environment
 * opt-out recreated the split-brain condition this lease exists to prevent.
 *
 * The evidence phase this flag existed for is over, and it ended the hard
 * way: during the 23:48Z deploy overlap, two engine instances dealt table
 * eab2e2e1 SIMULTANEOUSLY — the incoming container logged "lost the lease…
 * (enforcement off; still dealing)" and kept dealing anyway. Dan was SEATED
 * at that table: hands completed in 3.8 seconds flat, his all-in with KK
 * resolved with no flop ever shown, turns appeared to skip, pots teleported.
 * Two dealers, one table, real money — the precise correctness failure the
 * 2026-08-16 incident predicted and this module was built to stop.
 *
 * The teardown path this switch arms (GameServer's discovery loop: stop the
 * engine, drop the hub) has been live and inert for four days; every claim
 * and heartbeat has been logging cleanly. A heartbeat error still never stops
 * an already-running table, but a new claim must now be verified while
 * enforcement is on. A database blip is retried instead of creating an
 * unleased second dealer.
 */
export const LEASE_ENFORCED: true = true;

export interface LeaseConflict {
  tableId: string;
  holder: string | null;
  holderAgeSeconds: number | null;
  at: number;
}

export type TableLeaseClaimResult =
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
  | { status: 'owned_elsewhere'; conflict: LeaseConflict }
  | {
      status: 'retryable_failure';
      reason: 'rpc_error' | 'rpc_threw' | 'malformed_response';
      requestedGeneration: string;
      mayHaveCommitted: boolean;
    };

/**
 * Conflicts seen since boot. Surfaced on /health so a split-brain is visible
 * from outside the box without reading container logs — the thing we did not
 * have on 2026-08-16.
 */
const conflicts = new Map<string, LeaseConflict>();
let claimErrors = 0;
let heartbeatErrors = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TableLeaseHeartbeatClaim {
  tableId: string;
  leaseGeneration: string;
}

export type TableLeaseReleaseOutcome =
  | { status: 'confirmed'; releasedCount: number; attempts: number }
  | {
      status: 'uncertain';
      reason: 'invalid_claims' | 'rpc_error' | 'rpc_threw' | 'malformed_response';
      detail: string;
      attempts: number;
    };

const LEASE_RELEASE_MAX_ATTEMPTS = 2;

export function recentLeaseConflicts(limit = 20): LeaseConflict[] {
  return [...conflicts.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

export function leaseDiagnostics() {
  return {
    instanceId: INSTANCE_ID,
    enforced: LEASE_ENFORCED,
    conflictCount: conflicts.size,
    claimErrors,
    heartbeatErrors,
    // Missing/stale heartbeat results — leases nobody took. Before 2026-08-29
    // every one of these was counted as a conflict and stopped a live table.
    reclaimableHeartbeats,
    conflicts: recentLeaseConflicts(),
  };
}

/** Test seam — the suite needs a clean slate between cases. */
export function _resetLeaseState(): void {
  conflicts.clear();
  claimErrors = 0;
  heartbeatErrors = 0;
  reclaimableHeartbeats = 0;
}

function unverifiedClaimResult(
  tableId: string,
  requestedGeneration: string,
  mayHaveCommitted: boolean,
  reason: 'rpc_error' | 'rpc_threw' | 'malformed_response',
  detail: string
): TableLeaseClaimResult {
  claimErrors++;
  if (claimErrors <= 3) {
    console.warn(
      `[lease] claim_table_lease ${reason} for ${tableId} (${detail}) - ` +
        'refusing to deal until ownership can be proven'
    );
  }
  return { status: 'retryable_failure', reason, requestedGeneration, mayHaveCommitted };
}

/**
 * Try to take (or renew) one table lease without erasing why admission failed.
 *
 * A verified grant is the only success. Transport/RPC failures and malformed
 * payloads are retryable: silence is not proof that no other dealer owns the
 * table.
 */
export async function claimTableLease(
  tableId: string,
  requestedGeneration: string
): Promise<TableLeaseClaimResult> {
  if (!UUID_PATTERN.test(requestedGeneration)) {
    return unverifiedClaimResult(
      tableId,
      requestedGeneration,
      false,
      'malformed_response',
      'caller supplied an invalid requested generation'
    );
  }
  const proofDeadlineMonotonicMs = tableLeaseMonotonicNow() + TABLE_LEASE_PROOF_WINDOW_MS;
  try {
    const { data, error } = await supabase.rpc('claim_table_lease_v2', {
      p_table_id: tableId,
      p_instance_id: INSTANCE_ID,
      p_version: INSTANCE_VERSION,
      p_requested_generation: requestedGeneration,
      p_stale_seconds: LEASE_STALE_SECONDS,
    });

    if (error) {
      return unverifiedClaimResult(
        tableId,
        requestedGeneration.toLowerCase(),
        true,
        'rpc_error',
        String(error.message || 'unknown error')
      );
    }

    // The RPC RETURNS TABLE, so PostgREST hands back an array of one row.
    const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
    if (
      !row ||
      typeof row !== 'object' ||
      typeof (row as { granted?: unknown }).granted !== 'boolean'
    ) {
      return unverifiedClaimResult(
        tableId,
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
          tableId,
          requestedGeneration.toLowerCase(),
          true,
          'malformed_response',
          'a granted response did not prove the exact requested protocol-2 generation'
        );
      }
      if (tableLeaseMonotonicNow() >= proofDeadlineMonotonicMs) {
        /* PostgreSQL already committed this exact generation. Returning an
           ordinary retry would orphan a fresh invisible lease for 30 seconds.
           The admission owner must exact-release it before choosing a new UUID. */
        claimErrors++;
        return {
          status: 'acquired_but_proof_expired',
          leaseGeneration: leaseRow.lease_generation.toLowerCase(),
        };
      }
      conflicts.delete(tableId);
      return {
        status: 'granted',
        verified: true,
        leaseGeneration: leaseRow.lease_generation.toLowerCase(),
        proofDeadlineMonotonicMs,
      };
    }

    const rawAge = leaseRow.holder_age_seconds;
    const numericAge = rawAge === null || rawAge === undefined ? null : Number(rawAge);

    const conflict: LeaseConflict = {
      tableId,
      holder: typeof leaseRow.holder === 'string' ? leaseRow.holder : null,
      holderAgeSeconds: numericAge !== null && Number.isFinite(numericAge) ? numericAge : null,
      at: Date.now(),
    };
    conflicts.set(tableId, conflict);
    console.warn(
      `[lease] SPLIT-BRAIN: table ${tableId} is held by instance ${conflict.holder} ` +
        `(last heartbeat ${conflict.holderAgeSeconds}s ago). This instance is ${INSTANCE_ID}. ` +
        'Refusing to deal it.'
    );
    return { status: 'owned_elsewhere', conflict };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return unverifiedClaimResult(
      tableId,
      requestedGeneration.toLowerCase(),
      true,
      'rpc_threw',
      detail
    );
  }
}

/** What the database says is true of one id we asked to renew. */
export type LeaseState = 'kept' | 'taken' | 'stale' | 'missing';

export interface TableLeaseHeartbeatProof {
  tableId: string;
  leaseGeneration: string;
  proofDeadlineMonotonicMs: number;
}

export type TableLeaseHeartbeatOutcome =
  | {
      status: 'answered';
      proofs: TableLeaseHeartbeatProof[];
      lostTableIds: string[];
    }
  | {
      status: 'uncertain';
      reason: 'rpc_error' | 'rpc_threw';
    };

/** Counters behind the /health lease block, so the split is visible remotely. */
let reclaimableHeartbeats = 0;

/**
 * Renew every lease this instance believes it holds.
 *
 * A transport failure is UNKNOWN: it extends nothing, and each engine keeps
 * running only until its previously proven local deadline. A successful RPC
 * must prove one exact `kept` row for every requested id. `taken`, `stale`,
 * `missing`, duplicate, omitted, or malformed rows all mean the old engine no
 * longer has a current proof and must fail-stop before a database takeover is
 * possible. That is deliberately stricter than the pre-deadline behavior,
 * which allowed an UNKNOWN heartbeat to keep a dealer alive forever.
 */
export async function heartbeatTables(
  claims: TableLeaseHeartbeatClaim[]
): Promise<TableLeaseHeartbeatOutcome> {
  if (claims.length === 0) {
    return { status: 'answered', proofs: [], lostTableIds: [] };
  }
  const tableIds = claims.map((claim) => claim.tableId);
  const uniqueTableIds = new Set(tableIds);
  if (
    uniqueTableIds.size !== claims.length ||
    claims.some((claim) => !UUID_PATTERN.test(claim.leaseGeneration))
  ) {
    heartbeatErrors++;
    if (heartbeatErrors <= 3) {
      console.warn('[lease] heartbeat refused malformed or duplicate generation claims');
    }
    return { status: 'answered', proofs: [], lostTableIds: tableIds };
  }
  const proofDeadlineMonotonicMs = tableLeaseMonotonicNow() + TABLE_LEASE_PROOF_WINDOW_MS;
  try {
    const { data, error } = await supabase.rpc('heartbeat_table_leases_v3', {
      p_instance_id: INSTANCE_ID,
      p_claims: claims.map((claim) => ({
        table_id: claim.tableId,
        lease_generation: claim.leaseGeneration,
      })),
      p_stale_seconds: LEASE_STALE_SECONDS,
    });
    if (error) {
      heartbeatErrors++;
      if (heartbeatErrors <= 3) {
        console.warn(
          `[lease] heartbeat failed (${error.message}) - retaining only the prior proof window`
        );
      }
      return { status: 'uncertain', reason: 'rpc_error' };
    }

    const rawRows = Array.isArray(data) ? data : null;
    const expectedIds = new Set(tableIds);
    const rowsById = new Map<string, { state: LeaseState; leaseGeneration: unknown }>();
    let malformed = rawRows === null || rawRows.length !== claims.length;
    for (const candidate of rawRows ?? []) {
      if (!candidate || typeof candidate !== 'object') {
        malformed = true;
        continue;
      }
      const row = candidate as {
        table_id?: unknown;
        state?: unknown;
        lease_generation?: unknown;
      };
      if (
        typeof row.table_id !== 'string' ||
        !expectedIds.has(row.table_id) ||
        !['kept', 'taken', 'stale', 'missing'].includes(String(row.state)) ||
        rowsById.has(row.table_id)
      ) {
        malformed = true;
        continue;
      }
      rowsById.set(row.table_id, {
        state: row.state as LeaseState,
        leaseGeneration: row.lease_generation,
      });
    }

    if (malformed || rowsById.size !== claims.length) {
      heartbeatErrors++;
      if (heartbeatErrors <= 3) {
        console.warn('[lease] heartbeat returned an incomplete or malformed ownership proof');
      }
      return { status: 'answered', proofs: [], lostTableIds: [...tableIds] };
    }

    const proofs: TableLeaseHeartbeatProof[] = [];
    const lostTableIds: string[] = [];

    for (const claim of claims) {
      const row = rowsById.get(claim.tableId)!;
      const exactGeneration =
        typeof row.leaseGeneration === 'string' &&
        row.leaseGeneration.toLowerCase() === claim.leaseGeneration.toLowerCase();
      if (
        row.state === 'kept' &&
        exactGeneration &&
        tableLeaseMonotonicNow() < proofDeadlineMonotonicMs
      ) {
        proofs.push({ ...claim, proofDeadlineMonotonicMs });
        continue;
      }

      lostTableIds.push(claim.tableId);
      if (row.state === 'taken' || (row.state === 'kept' && !exactGeneration)) {
        conflicts.set(claim.tableId, {
          tableId: claim.tableId,
          holder: null,
          holderAgeSeconds: null,
          at: Date.now(),
        });
        console.warn(
          `[lease] table ${claim.tableId} no longer proves generation ${claim.leaseGeneration}` +
            '. Stopping the previously verified dealer here.'
        );
        continue;
      }
      reclaimableHeartbeats++;
      console.warn(
        `[lease] table ${claim.tableId} no longer has a current ${row.state} ownership proof. Stopping it before re-admission.`
      );
    }

    return { status: 'answered', proofs, lostTableIds };
  } catch (err) {
    heartbeatErrors++;
    if (heartbeatErrors <= 3) {
      console.warn(
        `[lease] heartbeat threw (${(err as Error)?.message}) - retaining only the prior proof window`
      );
    }
    return { status: 'uncertain', reason: 'rpc_threw' };
  }
}

/** Reclaimable (missing/stale, NOT taken) heartbeat results since boot. */
export function reclaimableLeaseCount(): number {
  return reclaimableHeartbeats;
}

/**
 * Hand back exact leases on the way out. A confirmed zero is also proof: this
 * generation was already absent and no successor was touched. An uncertain
 * answer is intentionally returned to the lifecycle owner, because claiming a
 * successful rolling handoff while fresh rows may remain creates a guaranteed
 * 30-second table outage.
 */
export async function releaseTables(
  claims: TableLeaseHeartbeatClaim[] = []
): Promise<TableLeaseReleaseOutcome> {
  if (claims.length === 0) {
    return { status: 'confirmed', releasedCount: 0, attempts: 0 };
  }
  if (
    new Set(claims.map((claim) => claim.tableId)).size !== claims.length ||
    claims.some(
      (claim) => !UUID_PATTERN.test(claim.tableId) || !UUID_PATTERN.test(claim.leaseGeneration)
    )
  ) {
    return {
      status: 'uncertain',
      reason: 'invalid_claims',
      detail: 'release requires unique table ids and one valid generation per table',
      attempts: 0,
    };
  }
  let lastFailure: Exclude<TableLeaseReleaseOutcome, { status: 'confirmed' }> = {
    status: 'uncertain',
    reason: 'rpc_threw',
    detail: 'release did not run',
    attempts: 0,
  };
  const payload = {
    p_instance_id: INSTANCE_ID,
    p_claims: claims.map((claim) => ({
      table_id: claim.tableId,
      lease_generation: claim.leaseGeneration,
    })),
  };
  for (let attempt = 1; attempt <= LEASE_RELEASE_MAX_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await supabase.rpc('release_table_leases_v2', payload);
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
