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
    void flushHorseMind();
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
}
