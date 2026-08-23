/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE MIND PERSISTENCE — Unlimited Learning Horizon (V12 — 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Dan: "they should be watching and tracking all of their plays, as well as the
 * plays of everyone else at their tables, and constantly improving the more
 * they play."
 *
 * Before V12 the horses' learned opponent reads lived only in process memory,
 * rebuilt after every restart by replaying 72h of hand_history — anything
 * older than the replay window was forgotten forever. This service closes the
 * loop with the `horse_mind_stats` table:
 *
 *  - FLUSH: every FLUSH_INTERVAL_MS, rows that changed since the last flush go
 *    to the DB through the `upsert_horse_mind_stats` RPC. The RPC merges with
 *    GREATEST on lifetime counters, so a bounded-memory generation swap in the
 *    engine can never clobber accumulated history.
 *  - HYDRATE: on boot, the most-observed opponents load back instantly, then
 *    the history replay covers only the un-flushed tail since the last flush.
 *
 * Fail-safe by construction: every DB touch is caught and reported; a failed
 * flush requeues its rows for the next cycle; a failed hydrate falls back to
 * the pre-V12 behavior (full-window replay). Decisions never wait on any of
 * this. NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { HorseMind, type OpponentStats } from '../engine/HorseMind.js';
import { reportError } from './errorReporter.js';

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const FLUSH_CHUNK = 400;
/** Hydrate the most-observed opponents first, bounded well under the engine's
 *  own MAX_TRACKED_PLAYERS cap. */
const HYDRATE_LIMIT = 3000;

let flushTimer: NodeJS.Timeout | null = null;

type DbRow = {
  user_id: string;
  hands: number;
  vpip: number;
  pfr: number;
  three_bet: number;
  aggr: number;
  passive: number;
  folds: number;
  faced_aggr: number;
  r_hands: number;
  r_folds: number;
  r_faced_aggr: number;
  r_aggr: number;
  r_passive: number;
  updated_at?: string;
};

const toDb = (r: { user_id: string } & OpponentStats): DbRow => ({
  user_id: r.user_id,
  hands: r.hands,
  vpip: r.vpip,
  pfr: r.pfr,
  three_bet: r.threeBet,
  aggr: r.aggr,
  passive: r.passive,
  folds: r.folds,
  faced_aggr: r.facedAggr,
  r_hands: r.rHands,
  r_folds: r.rFolds,
  r_faced_aggr: r.rFacedAggr,
  r_aggr: r.rAggr,
  r_passive: r.rPassive,
});

const fromDb = (r: DbRow): { user_id: string } & OpponentStats => ({
  user_id: r.user_id,
  hands: r.hands,
  vpip: r.vpip,
  pfr: r.pfr,
  threeBet: r.three_bet,
  aggr: r.aggr,
  passive: r.passive,
  folds: r.folds,
  facedAggr: r.faced_aggr,
  rHands: r.r_hands,
  rFolds: r.r_folds,
  rFacedAggr: r.r_faced_aggr,
  rAggr: r.r_aggr,
  rPassive: r.r_passive,
});

type DbPairRow = {
  attacker_id: string;
  victim_id: string;
  n3: number;
  opp3: number;
  n_r: number;
  opp_r: number;
};

/**
 * V12.1: the anti-exploit pair-targeting counters (who 3-bets whose opens,
 * who raises whose bets) used to be in-memory only, rebuilt after a restart
 * by the 72h replay — a hunter with a longer memory than that got a clean
 * slate every deploy. Same flush/hydrate contract as the stats table.
 */
export async function flushHorseMindPairs(): Promise<{ flushed: number; failed: number }> {
  const rows = HorseMind.exportDirtyPairs();
  if (rows.length === 0) return { flushed: 0, failed: 0 };
  let flushed = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
    const chunk = rows.slice(i, i + FLUSH_CHUNK);
    try {
      const { error } = await supabase.rpc('upsert_horse_mind_pairs', {
        rows: chunk.map(
          (r): DbPairRow => ({
            attacker_id: r.attacker_id,
            victim_id: r.victim_id,
            n3: r.n3,
            opp3: r.opp3,
            n_r: r.nR,
            opp_r: r.oppR,
          })
        ),
      });
      if (error) throw new Error(error.message || 'upsert_horse_mind_pairs failed');
      flushed += chunk.length;
    } catch (err) {
      failed += chunk.length;
      HorseMind.requeueDirtyPairs(chunk);
      reportError(err, 'HorseMindPersistence.flushPairs');
    }
  }
  return { flushed, failed };
}

/**
 * Boot-time pair hydration: the most-contested pairs first (ordered by total
 * observed opportunities via the generated `opps` column). Fail-safe: any
 * error is reported and swallowed — the pre-V12.1 behavior (replay only) is
 * the fallback. Returns the number of rows applied.
 */
export async function hydrateHorsePairsFromDb(): Promise<number> {
  try {
    const t0 = Date.now();
    const { data, error } = await supabase
      .from('horse_mind_pairs')
      .select('attacker_id,victim_id,n3,opp3,n_r,opp_r')
      .order('opps', { ascending: false })
      .limit(HYDRATE_LIMIT);
    if (error) throw new Error(error.message || 'horse_mind_pairs read failed');
    if (!data || data.length === 0) return 0;
    const applied = HorseMind.importPairs(
      (data as DbPairRow[]).map((r) => ({
        attacker_id: r.attacker_id,
        victim_id: r.victim_id,
        n3: r.n3,
        opp3: r.opp3,
        nR: r.n_r,
        oppR: r.opp_r,
      }))
    );
    console.log(
      `[HorseMind] DB pair hydration: ${applied}/${data.length} targeting pairs restored in ` +
        `${Date.now() - t0}ms`
    );
    return applied;
  } catch (err) {
    reportError(err, 'HorseMindPersistence.hydratePairs');
    return 0;
  }
}

/** Push every dirty row to the DB. Failed chunks are requeued. */
export async function flushHorseMind(): Promise<{ flushed: number; failed: number }> {
  const rows = HorseMind.exportDirty();
  if (rows.length === 0) return { flushed: 0, failed: 0 };
  let flushed = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
    const chunk = rows.slice(i, i + FLUSH_CHUNK);
    try {
      const { error } = await supabase.rpc('upsert_horse_mind_stats', {
        rows: chunk.map(toDb),
      });
      if (error) throw new Error(error.message || 'upsert_horse_mind_stats failed');
      flushed += chunk.length;
    } catch (err) {
      failed += chunk.length;
      HorseMind.requeueDirty(chunk.map((c) => c.user_id));
      reportError(err, 'HorseMindPersistence.flush');
    }
  }
  return { flushed, failed };
}

/**
 * Boot-time hydration. Returns the timestamp of the most recent flushed row
 * (so the caller can replay only the un-flushed hand_history tail), or null
 * when the table is empty / unreadable (caller falls back to the full-window
 * replay — the exact pre-V12 behavior).
 */
export async function hydrateHorseMindFromDb(): Promise<string | null> {
  // V12.1: pair hydration rides the same boot call, with its own fail-safe —
  // a pairs failure must never cost the stats hydration (or vice versa).
  await hydrateHorsePairsFromDb();
  try {
    const t0 = Date.now();
    const { data, error } = await supabase
      .from('horse_mind_stats')
      .select(
        'user_id,hands,vpip,pfr,three_bet,aggr,passive,folds,faced_aggr,r_hands,r_folds,r_faced_aggr,r_aggr,r_passive,updated_at'
      )
      .order('hands', { ascending: false })
      .limit(HYDRATE_LIMIT);
    if (error) throw new Error(error.message || 'horse_mind_stats read failed');
    if (!data || data.length === 0) return null;

    const applied = HorseMind.importStats((data as DbRow[]).map(fromDb));
    let newest: string | null = null;
    for (const r of data as DbRow[]) {
      if (r.updated_at && (!newest || r.updated_at > newest)) newest = r.updated_at;
    }
    console.log(
      `[HorseMind] DB hydration: ${applied}/${data.length} opponent profiles restored in ` +
        `${Date.now() - t0}ms (replay tail since ${newest ?? 'n/a'})`
    );
    return newest;
  } catch (err) {
    reportError(err, 'HorseMindPersistence.hydrate');
    return null;
  }
}

/** Start the periodic flush loop. Idempotent. */
export function startHorseMindPersistence(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void (async () => {
      await flushHorseMind();
      await flushHorseMindPairs();
    })();
  }, FLUSH_INTERVAL_MS);
  // Never keep the process alive just to flush horse memory.
  flushTimer.unref?.();
}

/** Final best-effort flush for graceful shutdown (bounded by caller's race). */
export async function stopHorseMindPersistence(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushHorseMind();
  await flushHorseMindPairs();
}
