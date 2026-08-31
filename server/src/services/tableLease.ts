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
 * ── FAIL-OPEN, DELIBERATELY ─────────────────────────────────────────────────
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
 *   - Every RPC failure resolves to "carry on". A database blip must never be
 *     the reason a table stops dealing. We decline to START a table only on a
 *     definite `granted: false` from the database, and we STOP dealing one only
 *     on a definite report that someone else took it.
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
 * and heartbeat has been logging cleanly. Fail-open behaviour on RPC ERRORS
 * is unchanged — a database blip still never stops a table. What changes is
 * only the split-brain case, where continuing to deal was never safe.
 */
export const LEASE_ENFORCED: boolean = process.env.ENGINE_LEASE_ENFORCE !== 'off';

export interface LeaseConflict {
  tableId: string;
  holder: string | null;
  holderAgeSeconds: number | null;
  at: number;
}

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

/**
 * Try to take (or renew) the lease on one table.
 *
 * @returns true when this instance may deal the table. A transport/RPC error
 *          also returns true — see the fail-open note. Only an explicit
 *          `granted: false` from the database, WITH enforcement switched on,
 *          returns false.
 */
export async function claimTable(tableId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('claim_table_lease', {
      p_table_id: tableId,
      p_instance_id: INSTANCE_ID,
      p_version: INSTANCE_VERSION,
      p_stale_seconds: LEASE_STALE_SECONDS,
    });

    if (error) {
      claimErrors++;
      // Log once per table rather than every 5s tick — a missing function or a
      // permissions problem would otherwise bury the log at 12 lines/minute
      // per table.
      if (claimErrors <= 3) {
        console.warn(
          `[lease] claim_table_lease failed for ${tableId} (${error.message}) - proceeding without a lease`
        );
      }
      return true;
    }

    // The RPC RETURNS TABLE, so PostgREST hands back an array of one row.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.granted !== false) return true;

    const conflict: LeaseConflict = {
      tableId,
      holder: row.holder ?? null,
      holderAgeSeconds:
        row.holder_age_seconds === null || row.holder_age_seconds === undefined
          ? null
          : Number(row.holder_age_seconds),
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
    return !LEASE_ENFORCED;
  } catch (err) {
    claimErrors++;
    if (claimErrors <= 3) {
      console.warn(
        `[lease] claim threw for ${tableId} (${(err as Error)?.message}) - proceeding without a lease`
      );
    }
    return true;
  }
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
 * (missing) is not hypothetical: claimTable is deliberately fail-open and
 * starts dealing WITHOUT writing a row when the claim RPC errors or times out,
 * and the engine logged 596 supabase_timeouts in the hour this was written.
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
 * Grant is detected by side effect: claimTable() rewrites the conflicts entry
 * (new `at`) when it is refused again, and leaves it untouched when granted.
 * An RPC error also leaves it untouched, so a hard DB outage can retire a
 * conflict record early; it reappears on the next genuine refusal, and
 * `claimErrors` already counts that case separately.
 *
 * @returns how many tables were reclaimed on this pass.
 */
export async function retryRefusedClaims(): Promise<number> {
  let reclaimed = 0;
  for (const [tableId, before] of [...conflicts.entries()]) {
    await claimTable(tableId);
    const after = conflicts.get(tableId);
    if (after && after.at === before.at) {
      conflicts.delete(tableId);
      reclaimed++;
    }
  }
  return reclaimed;
}
