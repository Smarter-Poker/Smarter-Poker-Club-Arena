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
 * same claim / heartbeat / release shape, same 30s staleness, same fail-open
 * rules. One pattern to understand, and the table version is already proven.
 *
 * ── FAIL-OPEN, FOR THE SAME REASON ──────────────────────────────────────────
 *
 * A lease check sits in front of "may I run this tournament", so a bug here
 * could stop every tournament on the platform — the outcome it exists to
 * prevent. Therefore:
 *
 *   - Enforcement is OFF unless ENGINE_TOURNAMENT_LEASE_ENFORCE === 'on'. Until
 *     then this claims, heartbeats and LOGS conflicts while `claimTournament()`
 *     still answers true. Evidence before behaviour — exactly how the table
 *     lease was rolled out, and it is why turning that one on was safe.
 *   - Every RPC failure resolves to "carry on". A database blip must never be
 *     the reason a tournament stops. We decline to START only on a definite
 *     `granted: false`, and we STOP only on a definite report that someone else
 *     took it.
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
  process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE === 'on';

export interface TournamentConflict {
  tournamentId: string;
  holder: string | null;
  holderAgeSeconds: number | null;
  at: number;
}

const conflicts = new Map<string, TournamentConflict>();
let claimErrors = 0;
let heartbeatErrors = 0;
/** Missing/stale heartbeat results — leases nobody took. See heartbeatTournaments. */
let reclaimableHeartbeats = 0;

/**
 * May this instance run `tournamentId`?
 *
 * Returns true on any error and whenever enforcement is off — a lease problem
 * must never be the reason a tournament fails to start.
 */
export async function claimTournament(tournamentId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('claim_tournament_lease', {
      p_tournament_id: tournamentId,
      p_instance_id: INSTANCE_ID,
      p_version: INSTANCE_VERSION,
      p_stale_seconds: TOURNAMENT_LEASE_STALE_SECONDS,
    });
    if (error) {
      claimErrors++;
      if (claimErrors <= 3) {
        console.warn(`[tournament-lease] claim failed (${error.message}) - starting anyway`);
      }
      return true;
    }
    const row = (
      data as Array<{ granted: boolean; holder: string | null; holder_age_seconds: number | null }>
    )?.[0];
    if (!row || row.granted) {
      conflicts.delete(tournamentId);
      return true;
    }
    conflicts.set(tournamentId, {
      tournamentId,
      holder: row.holder,
      holderAgeSeconds: row.holder_age_seconds,
      at: Date.now(),
    });
    console.warn(
      `[tournament-lease] ${tournamentId} is held by ${row.holder}` +
        (TOURNAMENT_LEASE_ENFORCED ? '. Standing down.' : ' (enforcement off; running it anyway).')
    );
    return !TOURNAMENT_LEASE_ENFORCED;
  } catch (err) {
    claimErrors++;
    if (claimErrors <= 3) {
      console.warn(`[tournament-lease] claim threw (${(err as Error)?.message}) - starting anyway`);
    }
    return true;
  }
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
