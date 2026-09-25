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
import {
  mapLeaseHeartbeatBatches,
  RetainedLeaseHeartbeatBatches,
} from './leaseHeartbeatBatches.js';
import { warnThrottled, _resetLeaseWarnThrottleForTests } from './leaseWarningThrottle.js';
// Straight from the client module, never the `supabase.js` barrel: the barrel
// re-exports every submodule, so importing it from here would pull the whole
// data layer into the module graph for one rpc() call.
import { supabase } from './supabase/client.js';
import { leaseHeartbeatRpc } from './leaseHeartbeatSession.js';
/* Counted, not merely returned: every branch below that declines to renew a
   lease used to be silent, and repeated silent declines are exactly how a
   table ends up restarting every twenty seconds with nothing to read. */
import { leaseHeartbeatOutcomesTotal } from '../observability/engineInstruments.js';

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
  _resetLeaseWarnThrottleForTests();
}

function unverifiedClaimResult(
  tableId: string,
  requestedGeneration: string,
  mayHaveCommitted: boolean,
  reason: 'rpc_error' | 'rpc_threw' | 'malformed_response',
  detail: string
): TableLeaseClaimResult {
  claimErrors++;
  warnThrottled(
    'claim',
    `[lease] claim_table_lease ${reason} for ${tableId} (${detail}) - ` +
      'refusing to deal until ownership can be proven'
  );
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
export type LeaseState = 'kept' | 'taken' | 'stale' | 'missing' | 'busy';

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
      reason: 'rpc_error' | 'rpc_threw' | 'pending';
    };

/** Counters behind the /health lease block, so the split is visible remotely. */
let reclaimableHeartbeats = 0;

/**
 * Renew every lease this instance believes it holds.
 *
 * A transport failure is UNKNOWN: it extends nothing, and each engine keeps
 * running only until its previously proven local deadline. A successful RPC
 * proves a renewal only for an exact `kept` row. An exact `busy` row extends
 * nothing and retains only the prior deadline. `taken`, `stale`,
 * `missing`, duplicate, omitted, or malformed rows all mean the old engine no
 * longer has a current proof and must fail-stop before a database takeover is
 * possible. That is deliberately stricter than the pre-deadline behavior,
 * which allowed an UNKNOWN heartbeat to keep a dealer alive forever.
 */
const retainedTableHeartbeats = new RetainedLeaseHeartbeatBatches<
  TableLeaseHeartbeatClaim,
  TableLeaseHeartbeatOutcome
>();

export async function heartbeatTables(
  claims: TableLeaseHeartbeatClaim[],
  onBatch?: (outcome: TableLeaseHeartbeatOutcome) => void,
  ownerIsCurrent: () => boolean = () => true,
  claimIsCurrent: (claim: TableLeaseHeartbeatClaim) => boolean = () => true
): Promise<TableLeaseHeartbeatOutcome> {
  if (claims.length === 0) {
    return { status: 'answered', proofs: [], lostTableIds: [] };
  }
  const tableIds = claims.map((claim) => claim.tableId);
  const uniqueTableIds = new Set(tableIds.map((tableId) => tableId.toLowerCase()));
  if (
    uniqueTableIds.size !== claims.length ||
    claims.some(
      (claim) => !UUID_PATTERN.test(claim.tableId) || !UUID_PATTERN.test(claim.leaseGeneration)
    )
  ) {
    heartbeatErrors++;
    warnThrottled(
      'malformed_claims',
      '[lease] heartbeat refused malformed or duplicate generation claims'
    );
    /* EVERY CLAIM IS ACCOUNTED FOR, ESPECIALLY THE UNREADABLE ONES (2026-09-12)
         `state=malformed` has been declared and zero-seeded in engineInstruments
         since this counter shipped, described there as "the response could not be
         read as an answer". Nothing ever incremented it: both whole-answer refusals
         return here, above the per-row loop that is the counter's only writer, so
         production read exactly 0 while this path fenced the fleet.
         That silence is not cosmetic. `LeaseHeartbeatsNotBeingKept` (critical, SMS)
         is a RATIO of not-kept to total, so a refusal that increments neither half
         contributes nothing to either - the one event that loses every lease in a
         scope at once was the one event that alert could not see. Counting the
         claims here is what makes it 100% not-kept and fires it. */
    try {
      leaseHeartbeatOutcomesTotal.inc(claims.length, { scope: 'table', state: 'malformed' });
    } catch {
      /* metrics must never affect a lease decision */
    }
    return { status: 'answered', proofs: [], lostTableIds: tableIds };
  }
  const capturedClaims = claims.map((claim) => ({ ...claim }));
  const proofDeadlineMonotonicMs = tableLeaseMonotonicNow() + TABLE_LEASE_PROOF_WINDOW_MS;
  if (onBatch) {
    retainedTableHeartbeats.dispatch(
      capturedClaims,
      (claim) => `${claim.tableId.toLowerCase()}/${claim.leaseGeneration.toLowerCase()}`,
      () => ownerIsCurrent() && tableLeaseMonotonicNow() < proofDeadlineMonotonicMs,
      (batch) => {
        const currentClaims = batch.filter(claimIsCurrent);
        return currentClaims.length
          ? heartbeatTableBatch(currentClaims, proofDeadlineMonotonicMs)
          : Promise.resolve({ status: 'answered', proofs: [], lostTableIds: [] });
      },
      onBatch,
      (error) =>
        warnThrottled(
          'batch_delivery_failed',
          `[lease] heartbeat batch delivery failed: ${String(error)}`
        )
    );
    // Dispatch is not a renewal. Only a validated batch callback proves one.
    return { status: 'uncertain', reason: 'pending' };
  }
  const outcomes = await mapLeaseHeartbeatBatches(capturedClaims, (batch) =>
    heartbeatTableBatch(batch, proofDeadlineMonotonicMs)
  );
  const proofs: TableLeaseHeartbeatProof[] = [];
  const lostTableIds: string[] = [];
  let answered = false;
  for (const outcome of outcomes) {
    if (outcome.status !== 'answered') continue;
    answered = true;
    for (const proof of outcome.proofs) {
      // A proof that outran its own window extends nothing. It is not a loss:
      // the database answered `kept` for this exact generation to produce it.
      if (tableLeaseMonotonicNow() < proof.proofDeadlineMonotonicMs) proofs.push(proof);
    }
    lostTableIds.push(...outcome.lostTableIds);
  }
  // Unknown batches extend no authority; GameServer checks every captured
  // dealer's old deadline even when a separate batch returned exact proofs.
  return answered ? { status: 'answered', proofs, lostTableIds } : outcomes[0];
}

async function heartbeatTableBatch(
  claims: TableLeaseHeartbeatClaim[],
  passDeadlineMonotonicMs: number
): Promise<TableLeaseHeartbeatOutcome> {
  const tableIds = claims.map((claim) => claim.tableId);
  /* A QUEUED BATCH HAS NO EVIDENCE OF LOSS (2026-09-21). See the matching
     block in tournamentLease.ts: a batch that waited out the pass window
     never asked the database anything, so naming its claims as lost turned
     silence into a verdict and fenced live dealers. UNKNOWN extends nothing
     and accuses nothing; the ordinary expiry timer still owns the decision. */
  if (tableLeaseMonotonicNow() >= passDeadlineMonotonicMs) {
    return { status: 'uncertain', reason: 'pending' };
  }
  /* A PROOF IS MEASURED FROM THE REQUEST THAT EARNED IT. The window was
     opened once per PASS, before the first request, then shared by every
     batch; a batch that queued behind three others spent it waiting and its
     `kept` answer was discarded for arriving late. `heartbeat_at` is set by
     THIS statement, so a reading taken immediately before it is a
     conservative floor for it, well inside the audited stale window. */
  const proofDeadlineMonotonicMs = tableLeaseMonotonicNow() + TABLE_LEASE_PROOF_WINDOW_MS;
  try {
    /* LEASE RENEWAL CANNOT QUEUE BEHIND GAME TRAFFIC (2026-09-24): the
       dedicated session when configured, the shared client otherwise. Same
       arguments, same { data, error } answer. See leaseHeartbeatSession.ts. */
    const { data, error } = await leaseHeartbeatRpc('table', {
      p_instance_id: INSTANCE_ID,
      p_claims: claims.map((claim) => ({
        table_id: claim.tableId,
        lease_generation: claim.leaseGeneration,
      })),
      p_stale_seconds: LEASE_STALE_SECONDS,
    });
    if (error) {
      heartbeatErrors++;
      warnThrottled(
        'rpc_error',
        `[lease] heartbeat failed (${error.message}) - retaining only the prior proof window`
      );
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
        !['kept', 'taken', 'stale', 'missing', 'busy'].includes(String(row.state)) ||
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
      warnThrottled(
        'malformed_response',
        `[lease] heartbeat returned an incomplete or malformed ownership proof ` +
          `(requested=${claims.length}, received=${rawRows?.length ?? 'non-array'})`
      );
      /* See the note on the first whole-answer refusal above. */
      try {
        leaseHeartbeatOutcomesTotal.inc(claims.length, { scope: 'table', state: 'malformed' });
      } catch {
        /* metrics must never affect a lease decision */
      }
      return { status: 'answered', proofs: [], lostTableIds: [...tableIds] };
    }

    const proofs: TableLeaseHeartbeatProof[] = [];
    const lostTableIds: string[] = [];

    for (const claim of claims) {
      const row = rowsById.get(claim.tableId)!;
      try {
        leaseHeartbeatOutcomesTotal.inc(1, { scope: 'table', state: String(row.state) });
      } catch {
        /* metrics must never affect a lease decision */
      }
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

      // A locked exact generation is UNKNOWN, never a renewal. GameServer
      // checks the existing monotonic deadline after this response and its
      // ordinary expiry timer remains armed throughout repeated busy replies.
      if (row.state === 'busy' && exactGeneration) continue;

      /* A RENEWAL THAT ARRIVED LATE IS STILL A RENEWAL (2026-09-21). `kept`
         on the exact generation is the database saying this instance owned
         the row and advanced `heartbeat_at`. Too late to open a fresh local
         window grants no proof, but it is the strongest evidence AGAINST
         loss - and it used to fall through and fence the dealer. */
      if (row.state === 'kept' && exactGeneration) continue;

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
    warnThrottled(
      'rpc_threw',
      `[lease] heartbeat threw (${(err as Error)?.message}) - retaining only the prior proof window`
    );
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
