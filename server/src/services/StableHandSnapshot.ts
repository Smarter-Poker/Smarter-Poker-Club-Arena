/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - the floor snapshot
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE reader of the floor, consumed by two things that must never disagree:
 * the read-only dashboard (GET /stable-hand) and the executor that acts on the
 * plan. A dashboard built from a different query than the executor is a
 * dashboard reporting a floor nobody is managing.
 *
 * ── WHAT THE FIRST LIVE RUN FOUND (2026-09-04) ─────────────────────────────
 *
 * The dashboard had been written, typechecked and shipped, and had never once
 * been executed. The first run returned HTTP 200 and `n: 0` for BOTH hosts,
 * against a fleet of 1,000 horses.
 *
 * The cause was one line: `select('user_id, profiles!inner(is_horse)')` on
 * `club_members`. PostgREST answers that with
 *
 *     Could not embed because more than one relationship was found for
 *     'club_members' and 'profiles'
 *
 * and the old helper returned 0 on any error. The same embed against
 * `table_seats` and `table_waitlist` is unambiguous and works, which is
 * exactly why nothing looked broken: seats and waitlists read fine, so the
 * only wrong number was the population.
 *
 * WHY THAT ZERO WAS DANGEROUS, and not merely wrong. `n` is the denominator of
 * every cap. n = 0 gives peakCap 0, nightCap 0 and occupancy max 0, so a floor
 * of 188 live horses reads as 188 over the cap, and the planner asked for 170
 * stands. Nothing executed them - the executor ships human yield only, and
 * there were no humans waiting - but that is the phased rollout catching it,
 * not the code being safe. See the `host.n > 0` guard in planFloor, which now
 * refuses to wind a host down whose population it could not read.
 *
 * SO A FAILED READ IS NEVER A ZERO HERE. eligibleBodies returns `null` when it
 * could not read the whole membership, the host is left OUT of the snapshot
 * entirely, and its id goes in `unreadableHosts` so the plan says so out loud.
 * A host that cannot be measured is a host that must not be managed.
 *
 * Every read is paged (`fetchAllRows`) and every id list is chunked
 * (`selectInChunks`), because PostgREST truncates a select at 1,000 rows
 * without an error and refuses an `.in()` list past ~675 ids with a 400. The
 * plain membership read returned exactly 1,000 rows when this was written -
 * one row short of the ceiling is indistinguishable from a complete answer.
 */

import { supabase } from './supabase.js';
import { fetchAllRows } from './supabase/pagination.js';
import { selectInChunks } from './supabase/chunkedIn.js';
import { chicagoNow, type FloorSnapshot, type HostSnapshot } from './StableHandController.js';
import { MIDWAY_UNION_ID, DSS_CLUB_ID, WALLETS_FOR_HOST, killed } from './StableHand.js';

/** Membership statuses that make somebody a member of a club. */
const MEMBER_STATUSES = ['active', 'approved'];

/**
 * ── THE POPULATION IS CACHED; THE FLOOR IS NOT ─────────────────────────────
 *
 * `buildFloorSnapshot` runs every 30 seconds in the executor and again on
 * every dashboard request, and it was doing about thirteen round trips each
 * time - roughly 1,500 an hour. Six of those were `eligibleBodies`, which
 * pages two clubs' memberships and then asks which of those ids are horses,
 * to answer a number that changes when somebody joins a club. Once every five
 * minutes is far more often than that number moves.
 *
 * The tables, seats and waiting lists are NOT cached and must not be: they are
 * what the plan is computed from, and a stale one is a plan for a floor that
 * no longer exists.
 *
 * A refresh that fails keeps the LAST GOOD value rather than dropping to null.
 * Before the cache, a single unreadable membership page took the whole host
 * out of the snapshot for that cycle; now it costs nothing until the value is
 * genuinely old.
 */
export const POPULATION_TTL_MS = 5 * 60_000;
/** Beyond this the cached value is not served at all: a number this old is a
 *  guess, and a host measured by a guess should not be managed. */
export const POPULATION_MAX_AGE_MS = 60 * 60_000;

interface CachedPopulation {
  n: number;
  readAt: number;
}
const populationCache = new Map<string, CachedPopulation>();

/** For tests and for a deliberate re-read. */
export function clearPopulationCache(): void {
  populationCache.clear();
}

/**
 * The cached population for a host, refreshed when stale.
 *
 * Returns null only when there is nothing usable at all - never read, or the
 * last read is older than an hour and the refresh is still failing.
 */
export async function cachedEligibleBodies(
  hostId: string,
  nowMs: number = Date.now()
): Promise<number | null> {
  const hit = populationCache.get(hostId);
  if (hit && nowMs - hit.readAt < POPULATION_TTL_MS) return hit.n;

  const fresh = await eligibleBodies(hostId);
  if (fresh !== null && fresh > 0) {
    populationCache.set(hostId, { n: fresh, readAt: nowMs });
    return fresh;
  }
  // The read failed. Serve the last good value while it is still meaningful.
  if (hit && nowMs - hit.readAt < POPULATION_MAX_AGE_MS) return hit.n;
  return null;
}

/**
 * Eligible BODIES per host, or NULL when the membership could not be read
 * completely.
 *
 * Measured 2026-09-04: Union 584 (JAQK is a strict subset of Shark, so the
 * UNION of the two wallets is 584 bodies, not 1,164), DSS 416, and
 * 584 + 416 = 1,000 exactly. Read live so it self-corrects; the de-duplication
 * across wallets is the whole reason occupancy is capped per HOST and not per
 * club - per-club caps would count one body twice and deliver 80% occupancy
 * where Dan asked for 40%.
 */
export async function eligibleBodies(hostId: string): Promise<number | null> {
  const wallets = WALLETS_FOR_HOST[hostId] ?? [];
  if (wallets.length === 0) return null;

  const memberIds = new Set<string>();
  for (const clubId of wallets) {
    /* Keyset-paged per wallet, on user_id. club_members has no `id` column;
       its key is (club_id, user_id), so user_id is unique WITHIN one club and
       is the correct cursor once the club is fixed. */
    const page = await fetchAllRows<{ user_id: string }>(
      (cursor, want) => {
        let q = supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', clubId)
          .in('status', MEMBER_STATUSES)
          .order('user_id', { ascending: true })
          .limit(want);
        if (cursor) q = q.gt('user_id', cursor);
        return q;
      },
      { label: 'StableHand.eligibleBodies', idKey: 'user_id', maxRows: 50_000 }
    );
    // Fail CLOSED. Half a membership is not a smaller club, and a short count
    // here becomes a low cap and then a wind-down order.
    if (!page.complete) return null;
    page.rows.forEach((r) => memberIds.add(String(r.user_id)));
  }
  if (memberIds.size === 0) return 0;

  const horses = await selectInChunks<{ id: string }>(
    [...memberIds],
    (batch) => supabase.from('profiles').select('id').eq('is_horse', true).in('id', batch),
    'StableHand.eligibleBodies.horses'
  );
  if (!horses.complete) return null;
  return horses.rows.length;
}

export async function buildFloorSnapshot(): Promise<FloorSnapshot> {
  const now = chicagoNow();
  const hosts: HostSnapshot[] = [];
  const unreadableHosts: string[] = [];

  for (const hostId of [MIDWAY_UNION_ID, DSS_CLUB_ID]) {
    const n = await cachedEligibleBodies(hostId);
    if (n === null || n <= 0) {
      unreadableHosts.push(hostId);
      continue;
    }

    const tablePage = await fetchAllRows<{ id: string }>(
      (cursor, want) => {
        let q = supabase
          .from('tables')
          .select(
            'id, game_variant, small_blind, big_blind, max_players, status, current_players, cluster_id'
          )
          .eq('club_id', hostId)
          .is('tournament_id', null)
          .in('status', ['waiting', 'running', 'active'])
          .order('id', { ascending: true })
          .limit(want);
        if (cursor) q = q.gt('id', cursor);
        return q;
      },
      { label: 'StableHand.tables', maxRows: 50_000 }
    );
    if (!tablePage.complete) {
      unreadableHosts.push(hostId);
      continue;
    }
    const tables = tablePage.rows as any[];
    const tableIds = tables.map((t) => String(t.id));

    const seatRes = await selectInChunks<any>(
      tableIds,
      (batch) =>
        supabase
          .from('table_seats')
          .select('table_id, user_id, stack')
          .in('table_id', batch)
          .is('left_at', null),
      'StableHand.seats'
    );
    const waitRes = await selectInChunks<any>(
      tableIds,
      (batch) =>
        supabase
          .from('table_waitlist')
          .select('table_id, user_id, created_at')
          .in('table_id', batch)
          .eq('status', 'waiting'),
      'StableHand.waitlist'
    );
    if (!seatRes.complete || !waitRes.complete) {
      unreadableHosts.push(hostId);
      continue;
    }
    const seats = seatRes.rows;
    const waits = waitRes.rows;

    /* WHO IS A HORSE, asked separately rather than through an embed. The
       `profiles!inner(is_horse)` embed worked on these two tables and NOT on
       club_members, and one query shape that silently means different things
       depending on the table is how the population read returned 0 for a day.
       One way of asking, everywhere. */
    const occupantIds = [
      ...new Set([...seats.map((s) => String(s.user_id)), ...waits.map((w) => String(w.user_id))]),
    ];
    const horseRes = await selectInChunks<{ id: string }>(
      occupantIds,
      (batch) => supabase.from('profiles').select('id').eq('is_horse', true).in('id', batch),
      'StableHand.occupantHorses'
    );
    if (!horseRes.complete) {
      unreadableHosts.push(hostId);
      continue;
    }
    const horseIds = new Set(horseRes.rows.map((r) => String(r.id)));

    const seatsByTable = new Map<string, any[]>();
    seats.forEach((s) => {
      const k = String(s.table_id);
      if (!seatsByTable.has(k)) seatsByTable.set(k, []);
      seatsByTable.get(k)!.push(s);
    });

    const waitingByTable = new Map<string, number>();
    /* WHEN THE LONGEST-WAITING HUMAN JOINED, not when this pass first noticed
       them. The yield delay is 2-5 minutes and the cycle is 30 seconds, so
       measuring from "first seen" would add up to a cycle of detection lag on
       top of a window Dan specified as 2-5 minutes. Measured from created_at
       the promise is exact whatever the cycle does. */
    const oldestWaitByTable = new Map<string, number>();
    waits.forEach((w) => {
      // Only HUMANS on a list trigger a yield. Horses do not queue.
      if (horseIds.has(String(w.user_id))) return;
      const k = String(w.table_id);
      waitingByTable.set(k, (waitingByTable.get(k) ?? 0) + 1);
      const at = Date.parse(String(w.created_at ?? ''));
      if (!Number.isFinite(at)) return;
      const prev = oldestWaitByTable.get(k);
      if (prev === undefined || at < prev) oldestWaitByTable.set(k, at);
    });

    /* EVERY body on this host, human and horse. The occupancy curve is a
       target for how busy the FLOOR is - Dan's words were "there should not be
       89 PEOPLE playing in the middle of the night" - so a human sitting down
       counts, and the fleet recedes to make room for them. Counting horses
       alone overshot the curve by exactly the number of real players. */
    const uniqueLive = new Set(seats.map((s) => String(s.user_id))).size;

    hosts.push({
      hostId,
      n,
      uniqueLive,
      tables: tables.map((t: any) => {
        const rows = seatsByTable.get(String(t.id)) ?? [];
        const horses = rows.filter((r: any) => horseIds.has(String(r.user_id)));
        return {
          tableId: String(t.id),
          hostId,
          variant: String(t.game_variant ?? ''),
          sb: Number(t.small_blind ?? 0),
          bb: Number(t.big_blind ?? 0),
          maxPlayers: Number(t.max_players ?? 6),
          occupied: rows.length,
          humansSeated: rows.length - horses.length,
          humansWaiting: waitingByTable.get(String(t.id)) ?? 0,
          waitlistOldestJoinedAtMs: oldestWaitByTable.get(String(t.id)),
          seatedHorses: horses.map((h: any) => ({
            horseId: String(h.user_id),
            sittingOut: false,
            minutesAtTable: 0,
            isRed: false,
            stack: Number(h.stack ?? 0),
          })),
          status: String(t.status ?? ''),
          clusterId: t.cluster_id ? String(t.cluster_id) : null,
        };
      }),
    });
  }

  return {
    chicagoHour: now.hour,
    chicagoMinute: now.minute,
    hosts,
    killed: killed(),
    unreadableHosts,
  };
}
