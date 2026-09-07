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
 *   - Enforcement is OFF unless ENGINE_LEASE_ENFORCE === 'on'. Until then the
 *     module claims, heartbeats and LOGS conflicts, but `claimTable()` still
 *     answers true and `heartbeatTables()` still reports nothing lost. We get
 *     the evidence before we get the behaviour.
 *
 *   - With enforcement on, a claim RPC failure is `retryable_failure`, never a
 *     grant. Starting a second dealer because ownership could not be checked is
 *     a split-brain correctness failure, not a liveness recovery.
 *
 *   - The explicit enforcement-off escape hatch retains its historical
 *     fail-open behaviour. Its grants are marked `verified: false`, so callers
 *     and diagnostics never confuse an operator override with a database-
 *     confirmed lease.
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
 * Enforcement is ON BY DEFAULT as of 2026-08-20 (opt-OUT via
 * ENGINE_LEASE_ENFORCE=off, kept for emergencies).
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
export const LEASE_ENFORCED: boolean = process.env.ENGINE_LEASE_ENFORCE !== 'off';

export interface LeaseConflict {
  tableId: string;
  holder: string | null;
  holderAgeSeconds: number | null;
  at: number;
}

export type TableLeaseClaimResult =
  | { status: 'granted'; verified: boolean }
  | { status: 'owned_elsewhere'; conflict: LeaseConflict }
  | {
      status: 'retryable_failure';
      reason: 'rpc_error' | 'rpc_threw' | 'malformed_response';
    };

/**
 * Conflicts seen since boot. Surfaced on /health so a split-brain is visible
 * from outside the box without reading container logs — the thing we did not
 * have on 2026-08-16.
 */
const conflicts = new Map<string, LeaseConflict>();
let claimErrors = 0;
let heartbeatErrors = 0;

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
  reason: 'rpc_error' | 'rpc_threw' | 'malformed_response',
  detail: string
): TableLeaseClaimResult {
  claimErrors++;
  if (claimErrors <= 3) {
    console.warn(
      `[lease] claim_table_lease ${reason} for ${tableId} (${detail}) - ` +
        (LEASE_ENFORCED
          ? 'refusing to deal until ownership can be proven'
          : 'proceeding without a verified lease because enforcement is off')
    );
  }
  return LEASE_ENFORCED
    ? { status: 'retryable_failure', reason }
    : { status: 'granted', verified: false };
}

/**
 * Try to take (or renew) one table lease without erasing why admission failed.
 *
 * A verified grant is the only success while enforcement is on. Transport/RPC
 * failures and malformed payloads are retryable: silence is not proof that no
 * other dealer owns the table. Enforcement off remains an explicit operator
 * escape hatch and returns an unverified grant while retaining diagnostics.
 */
export async function claimTableLease(tableId: string): Promise<TableLeaseClaimResult> {
  try {
    const { data, error } = await supabase.rpc('claim_table_lease', {
      p_table_id: tableId,
      p_instance_id: INSTANCE_ID,
      p_version: INSTANCE_VERSION,
      p_stale_seconds: LEASE_STALE_SECONDS,
    });

    if (error) {
      return unverifiedClaimResult(tableId, 'rpc_error', String(error.message || 'unknown error'));
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
        'malformed_response',
        'response did not contain one boolean granted discriminator'
      );
    }

    const leaseRow = row as {
      granted: boolean;
      holder?: unknown;
      holder_age_seconds?: unknown;
    };
    if (leaseRow.granted) return { status: 'granted', verified: true };

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
        (LEASE_ENFORCED
          ? 'Refusing to deal it.'
          : 'ENGINE_LEASE_ENFORCE is off, so dealing anyway - set it to "on" once these logs look right.')
    );
    return LEASE_ENFORCED
      ? { status: 'owned_elsewhere', conflict }
      : { status: 'granted', verified: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return unverifiedClaimResult(tableId, 'rpc_threw', detail);
  }
}

/**
 * Boolean compatibility adapter for the existing discovery call sites. New
 * admission code must use claimTableLease() so a transient ownership failure
 * remains retryable instead of being conflated with a foreign live owner.
 */
export async function claimTable(tableId: string): Promise<boolean> {
  return (await claimTableLease(tableId)).status === 'granted';
}

/** What the database says is true of one id we asked to renew. */
export type LeaseState = 'kept' | 'taken' | 'stale' | 'missing';

/** Counters behind the /health lease block, so the split is visible remotely. */
let reclaimableHeartbeats = 0;

/**
 * Renew every lease this instance believes it holds.
 *
 * @returns the subset of `tableIds` genuinely TAKEN by another live engine,
 *          which must be torn down here. Empty on any error, because "we could
 *          not ask" must never be read as "we lost everything"; that inversion
 *          is how a fail-safe becomes an outage.
 *
 * ONLY 'taken' IS A TAKEOVER (2026-08-29). This used to subtract the renewed
 * ids from the requested ids and call the whole remainder a takeover. Three
 * different situations produce that remainder and only one of them is a
 * takeover — the other two are "there is no row for this table" and "the row's
 * holder has gone quiet", both of which we may simply re-claim.
 *
 * (missing) is not hypothetical: an operator can explicitly disable
 * enforcement, a legacy process may have started fail-open, or a row can be
 * removed after admission. The engine logged 596 supabase_timeouts in the hour
 * this distinction was introduced.
 *
 * The cost of the old guess was measured, not theorised: 204 teardowns in one
 * hour, "another engine instance has taken it over. Stopping it here." — while
 * eight of those exact table ids were, in the database at that moment, held by
 * THIS instance with a 2.8-second-old heartbeat. Live tables and live
 * tournaments were being stopped for a split-brain that did not exist.
 */
export async function heartbeatTables(tableIds: string[]): Promise<string[]> {
  if (tableIds.length === 0) return [];
  try {
    const { data, error } = await supabase.rpc('heartbeat_table_leases_v2', {
      p_instance_id: INSTANCE_ID,
      p_table_ids: tableIds,
      p_stale_seconds: LEASE_STALE_SECONDS,
    });
    if (error) {
      heartbeatErrors++;
      if (heartbeatErrors <= 3) {
        console.warn(`[lease] heartbeat failed (${error.message}) - keeping every table`);
      }
      return [];
    }

    const rows = (data ?? []) as Array<{ table_id: string; state: LeaseState }>;
    const stateOf = new Map(rows.map((r) => [r.table_id, r.state]));
    const taken: string[] = [];
    let reclaimable = 0;

    for (const id of tableIds) {
      // An id the function did not answer for cannot be proven taken, so it is
      // treated as reclaimable. Silence is not evidence of a takeover — that
      // conflation is the entire bug this replaced.
      const state = stateOf.get(id) ?? 'missing';
      if (state === 'kept') continue;
      if (state === 'taken') {
        taken.push(id);
        conflicts.set(id, { tableId: id, holder: null, holderAgeSeconds: null, at: Date.now() });
        console.warn(
          `[lease] table ${id} is held by another LIVE engine instance` +
            (LEASE_ENFORCED ? '. Stopping it here.' : ' (enforcement off; still dealing).')
        );
        continue;
      }
      // 'missing' or 'stale' — nobody took it. claimTable will put the row
      // back on the next discovery tick; tearing the table down would be the
      // false alarm, not the safety measure.
      reclaimable++;
    }

    if (reclaimable > 0) {
      reclaimableHeartbeats += reclaimable;
      console.warn(
        `[lease] ${reclaimable} of ${tableIds.length} table leases were missing or stale, not taken - re-claiming, still dealing`
      );
    }

    return LEASE_ENFORCED ? taken : [];
  } catch (err) {
    heartbeatErrors++;
    if (heartbeatErrors <= 3) {
      console.warn(`[lease] heartbeat threw (${(err as Error)?.message}) - keeping every table`);
    }
    return [];
  }
}

/** Reclaimable (missing/stale, NOT taken) heartbeat results since boot. */
export function reclaimableLeaseCount(): number {
  return reclaimableHeartbeats;
}

/**
 * Hand back leases on the way out. Purely an optimisation: without it the
 * incoming container waits out LEASE_STALE_SECONDS on every table during a
 * rolling deploy. Never allowed to delay or fail a shutdown.
 */
export async function releaseTables(tableIds?: string[]): Promise<void> {
  try {
    await supabase.rpc('release_table_leases', {
      p_instance_id: INSTANCE_ID,
      p_table_ids: tableIds ?? null,
    });
  } catch {
    // Shutdown path — a failure here costs at most 30s of stale lease.
  }
}

/**
 * Re-attempt every claim this instance was refused, and forget the ones it
 * now holds.
 *
 * Why this exists (2026-08-17). `conflicts` is only ever written, never
 * cleared — there is no other `conflicts.delete` in this file. So a table
 * refused once stayed refused for the life of the process:
 *
 *   - With enforcement OFF, claimTable() still returns true, so GameServer
 *     starts the table anyway and puts it in `tableEngines`. The discovery
 *     loop then skips it forever (`if (this.tableEngines.has(id)) continue`),
 *     the claim is never retried, and the table deals with no lease row.
 *   - `conflictCount` on /health therefore latches. Observed right after the
 *     2026-08-17 cutover: 4 tables dealing with no lease and a conflict count
 *     pinned at 4 for the life of the container. That number is exactly the
 *     signal used to decide whether ENGINE_LEASE_ENFORCE can be switched on,
 *     so latching it makes the decision impossible to make.
 *
 * The refusals are almost always a cutover race — the outgoing container
 * still held a fresh lease when the incoming one asked, and released it
 * moments later. Asking again a few seconds on simply succeeds.
 *
 * A conflict is retired only by a VERIFIED grant. RPC errors, malformed
 * responses, and enforcement-off fail-open admissions are not proof that the
 * foreign owner is gone, so they retain the diagnostic row.
 *
 * @returns how many tables were reclaimed on this pass.
 */
export async function retryRefusedClaims(): Promise<number> {
  let reclaimed = 0;
  for (const tableId of [...conflicts.keys()]) {
    const result = await claimTableLease(tableId);
    if (result.status === 'granted' && result.verified) {
      conflicts.delete(tableId);
      reclaimed++;
    }
  }
  return reclaimed;
}
