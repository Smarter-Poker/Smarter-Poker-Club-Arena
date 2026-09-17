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
import { HorseMind, type ReadScope, type OpponentStats } from '../engine/HorseMind.js';
import { reportError } from './errorReporter.js';

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const FLUSH_CHUNK = 400;
/** A transport success is not proof that every exported row was processed.
 * These three existing RPCs return a scalar integer count, not a row list. */
function hasCompleteRowReceipt(value: unknown, expected: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value === expected;
}

/** Hydrate the most-observed opponents first, matching the engine's own
 *  MAX_TRACKED_PLAYERS cap. */
const HYDRATE_LIMIT = 4000;
/** V12.3: pairs have their OWN cap (MAX_PAIRS = 20000) and there are far more
 *  of them than players — one shared 3000 was dropping ~85% of the targeting
 *  memory on every boot, so most hunters still got the clean slate this table
 *  was built to deny them. Paged, because it is over PostgREST's default. */
const HYDRATE_LIMIT_PAIRS = 20_000;
const HYDRATE_PAGE = 1000;

let flushTimer: NodeJS.Timeout | null = null;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightFlushes = new Set<Promise<void>>();

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
  cbet_opps?: number;
  cbet_folds?: number;
  f3b_opps?: number;
  f3b_folds?: number;
  bigbet_sd?: number;
  bigbet_sd_strong?: number;
  post_aggr?: number;
  post_passive?: number;
  /** V34 (2026-09-02): the V23 river read and the V28 check counters,
   *  persisted at last — see 20260902233000_horse_mind_persist_postflop_af_and_river_reads. */
  river_bet_opps?: number;
  river_bet_folds?: number;
  checks?: number;
  r_checks?: number;
  /** V43 (2026-09-05): tempo reads - see 20260905210642_the_fleet_state_says_when_a_horse_last_acted_and_the_mind_remembers_tempo. */
  snap_bet_sd?: number;
  snap_bet_sd_strong?: number;
  tank_bet_sd?: number;
  tank_bet_sd_strong?: number;
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
  cbet_opps: r.cbetOpps,
  cbet_folds: r.cbetFolds,
  f3b_opps: r.f3bOpps,
  f3b_folds: r.f3bFolds,
  bigbet_sd: r.bigBetSD,
  bigbet_sd_strong: r.bigBetSDStrong,
  post_aggr: r.postAggr,
  post_passive: r.postPassive,
  river_bet_opps: r.riverBetOpps,
  river_bet_folds: r.riverBetFolds,
  snap_bet_sd: r.snapBetSD,
  snap_bet_sd_strong: r.snapBetSDStrong,
  tank_bet_sd: r.tankBetSD,
  tank_bet_sd_strong: r.tankBetSDStrong,
  checks: r.checks,
  r_checks: r.rChecks,
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
  cbetOpps: r.cbet_opps ?? 0,
  cbetFolds: r.cbet_folds ?? 0,
  f3bOpps: r.f3b_opps ?? 0,
  f3bFolds: r.f3b_folds ?? 0,
  bigBetSD: r.bigbet_sd ?? 0,
  bigBetSDStrong: r.bigbet_sd_strong ?? 0,
  postAggr: r.post_aggr ?? 0,
  postPassive: r.post_passive ?? 0,
  // V34: the V23 river reads and the V28 check counters are persisted now
  // (they were memory-only, so every deploy forgot who folds rivers). The
  // columns are nullable-by-age on a snapshot that predates the migration;
  // importStats keeps the larger of live and incoming for these, so a
  // hydrate can only add information.
  riverBetOpps: r.river_bet_opps ?? 0,
  riverBetFolds: r.river_bet_folds ?? 0,
  snapBetSD: r.snap_bet_sd ?? 0,
  snapBetSDStrong: r.snap_bet_sd_strong ?? 0,
  tankBetSD: r.tank_bet_sd ?? 0,
  tankBetSDStrong: r.tank_bet_sd_strong ?? 0,
  rHands: r.r_hands,
  rFolds: r.r_folds,
  rFacedAggr: r.r_faced_aggr,
  rAggr: r.r_aggr,
  rPassive: r.r_passive,
  checks: r.checks ?? 0,
  rChecks: r.r_checks ?? 0,
});

/** V12.3: the newest flush timestamp seen by the pair hydrate, so the caller
 *  can bound the history replay by BOTH tables (see hydrateHorseMindFromDb). */
let pairsNewestFlush: string | null = null;

type DbPairRow = {
  attacker_id: string;
  victim_id: string;
  n3: number;
  opp3: number;
  n_r: number;
  opp_r: number;
  updated_at?: string;
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
      const { data, error } = await supabase.rpc('upsert_horse_mind_pairs', {
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
      if (!hasCompleteRowReceipt(data, chunk.length)) {
        // Some rows may already have committed. The scalar count cannot name
        // them. Retain current keys for a later snapshot; do not blindly
        // repeat this unconfirmed batch through immediate individual writes.
        HorseMind.requeueDirtyPairs(chunk);
        failed += chunk.length;
        reportError(
          new Error('horse_mind_persistence_receipt_unconfirmed'),
          'HorseMindPersistence.flushPairs.receipt'
        );
        continue;
      }
      flushed += chunk.length;
    } catch (err) {
      // Isolate a failed chunk row by row so unaffected rows can progress.
      // A failed individual request does not establish a permanent bad row:
      // transport or service failures can affect every row. Retain only those
      // keys for a later flush, which exports current counters, not this stale
      // snapshot. No requeued key is retried again in this invocation.
      let recovered = 0;
      for (const row of chunk) {
        try {
          const { data, error } = await supabase.rpc('upsert_horse_mind_pairs', {
            rows: [
              {
                attacker_id: row.attacker_id,
                victim_id: row.victim_id,
                n3: row.n3,
                opp3: row.opp3,
                n_r: row.nR,
                opp_r: row.oppR,
              },
            ],
          });
          if (error) throw new Error(error.message);
          if (!hasCompleteRowReceipt(data, 1))
            throw new Error('horse_mind_persistence_receipt_unconfirmed');
          recovered++;
        } catch {
          HorseMind.requeueDirtyPairs([row]);
        }
      }
      flushed += recovered;
      failed += chunk.length - recovered;
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
    let applied = 0;
    let read = 0;
    let newest: string | null = null;
    for (let offset = 0; offset < HYDRATE_LIMIT_PAIRS; offset += HYDRATE_PAGE) {
      const { data, error } = await supabase
        .from('horse_mind_pairs')
        .select('attacker_id,victim_id,n3,opp3,n_r,opp_r,updated_at')
        .order('opps', { ascending: false })
        .order('attacker_id', { ascending: true })
        .range(offset, offset + HYDRATE_PAGE - 1);
      if (error) throw new Error(error.message || 'horse_mind_pairs read failed');
      if (!data || data.length === 0) break;
      read += data.length;
      applied += HorseMind.importPairs(
        (data as DbPairRow[]).map((r) => ({
          attacker_id: r.attacker_id,
          victim_id: r.victim_id,
          n3: r.n3,
          opp3: r.opp3,
          nR: r.n_r,
          oppR: r.opp_r,
        }))
      );
      for (const r of data as DbPairRow[]) {
        if (r.updated_at && (!newest || Date.parse(r.updated_at) > Date.parse(newest)))
          newest = r.updated_at;
      }
      if (data.length < HYDRATE_PAGE) break;
    }
    if (read === 0) return 0;
    pairsNewestFlush = newest;
    console.log(
      `[HorseMind] DB pair hydration: ${applied}/${read} targeting pairs restored in ` +
        `${Date.now() - t0}ms`
    );
    return applied;
  } catch (err) {
    reportError(err, 'HorseMindPersistence.hydratePairs');
    return 0;
  }
}

/** Push dirty rows; retain individually failed keys for a later flush. */
export async function flushHorseMind(): Promise<{ flushed: number; failed: number }> {
  const rows = HorseMind.exportDirty();
  if (rows.length === 0) return { flushed: 0, failed: 0 };
  let flushed = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
    const chunk = rows.slice(i, i + FLUSH_CHUNK);
    try {
      const { data, error } = await supabase.rpc('upsert_horse_mind_stats', {
        rows: chunk.map(toDb),
      });
      if (error) throw new Error(error.message || 'upsert_horse_mind_stats failed');
      if (!hasCompleteRowReceipt(data, chunk.length)) {
        // Some rows may already have committed. The scalar count cannot name
        // them. Retain current keys for a later snapshot; do not blindly
        // repeat this unconfirmed batch through immediate individual writes.
        HorseMind.requeueDirty(chunk.map((row) => row.user_id));
        failed += chunk.length;
        reportError(
          new Error('horse_mind_persistence_receipt_unconfirmed'),
          'HorseMindPersistence.flush.receipt'
        );
        continue;
      }
      flushed += chunk.length;
    } catch (err) {
      // Preserve row isolation and retain unresolved keys for a later flush.
      // Re-marking never restores an older snapshot over concurrent learning.
      let recovered = 0;
      for (const row of chunk) {
        try {
          const { data, error } = await supabase.rpc('upsert_horse_mind_stats', {
            rows: [toDb(row)],
          });
          if (error) throw new Error(error.message);
          if (!hasCompleteRowReceipt(data, 1))
            throw new Error('horse_mind_persistence_receipt_unconfirmed');
          recovered++;
        } catch {
          HorseMind.requeueDirty([row.user_id]);
        }
      }
      flushed += recovered;
      failed += chunk.length - recovered;
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
  pairsNewestFlush = null;
  const pairsApplied = await hydrateHorsePairsFromDb();
  // V45: the scoped overlay rides the same boot call, same fail-safe.
  await hydrateHorseMindScopedFromDb();
  try {
    const t0 = Date.now();
    const { data, error } = await supabase
      .from('horse_mind_stats')
      .select(
        'user_id,hands,vpip,pfr,three_bet,aggr,passive,folds,faced_aggr,cbet_opps,cbet_folds,f3b_opps,f3b_folds,bigbet_sd,bigbet_sd_strong,post_aggr,post_passive,river_bet_opps,river_bet_folds,checks,snap_bet_sd,snap_bet_sd_strong,tank_bet_sd,tank_bet_sd_strong,r_checks,r_hands,r_folds,r_faced_aggr,r_aggr,r_passive,updated_at'
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
    // ── V12.3: bound the replay by BOTH tables ───────────────────────────
    // observe() INCREMENTS pair counters, so replaying history that the
    // hydrated pairs already contain double-counts them — and the DB merge is
    // GREATEST-monotonic, which makes that inflation permanent and
    // unrecoverable. Replay from the OLDER of the two flush marks so neither
    // table is double-fed and neither has a gap.
    const replayFrom =
      newest && pairsNewestFlush
        ? Date.parse(pairsNewestFlush) < Date.parse(newest)
          ? pairsNewestFlush
          : newest
        : newest;
    console.log(
      `[HorseMind] DB hydration: ${applied}/${data.length} opponent profiles restored in ` +
        `${Date.now() - t0}ms (replay tail since ${replayFrom ?? 'n/a'})`
    );
    return replayFrom;
  } catch (err) {
    reportError(err, 'HorseMindPersistence.hydrate');
    // The stats read failed, so the caller falls back to a FULL-WINDOW replay.
    // Any pairs we just hydrated would then be incremented by history they
    // already contain. Drop them and let the replay rebuild them cleanly —
    // the DB copy is untouched and the next boot restores it.
    if (pairsApplied > 0) {
      HorseMind.clearPairs();
      console.warn(
        '[HorseMind] stats hydrate failed; dropped hydrated pairs so the full replay cannot double-count them'
      );
    }
    return null;
  }
}

// ═══ V45 SCOPED ROWS (2026-09-05) ═══ same shape as the pooled flush, its own
// table, its own RPC, its own fail-safe: a scoped failure never costs the
// pooled flush and vice versa. No recency columns travel (they stay pooled).
type ScopedDbRow = Omit<
  DbRow,
  'r_hands' | 'r_folds' | 'r_faced_aggr' | 'r_aggr' | 'r_passive' | 'r_checks'
> & {
  scope: ReadScope;
};

const toScopedDb = (r: { user_id: string; scope: ReadScope } & OpponentStats): ScopedDbRow => {
  const base = toDb(r);
  const { r_hands, r_folds, r_faced_aggr, r_aggr, r_passive, r_checks, ...rest } = base;
  void r_hands;
  void r_folds;
  void r_faced_aggr;
  void r_aggr;
  void r_passive;
  void r_checks;
  return { ...rest, scope: r.scope };
};

export async function flushHorseMindScoped(): Promise<{ flushed: number; failed: number }> {
  const rows = HorseMind.exportDirtyScoped();
  if (rows.length === 0) return { flushed: 0, failed: 0 };
  let flushed = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
    const chunk = rows.slice(i, i + FLUSH_CHUNK);
    try {
      const { data, error } = await supabase.rpc('upsert_horse_mind_stats_scoped', {
        rows: chunk.map(toScopedDb),
      });
      if (error) throw new Error(error.message || 'upsert_horse_mind_stats_scoped failed');
      if (!hasCompleteRowReceipt(data, chunk.length)) {
        // Some rows may already have committed. The scalar count cannot name
        // them. Retain current keys for a later snapshot; do not blindly
        // repeat this unconfirmed batch through immediate individual writes.
        HorseMind.requeueDirtyScoped(chunk);
        failed += chunk.length;
        reportError(
          new Error('horse_mind_persistence_receipt_unconfirmed'),
          'HorseMindPersistence.flushScoped.receipt'
        );
        continue;
      }
      flushed += chunk.length;
    } catch (err) {
      let recovered = 0;
      for (const row of chunk) {
        try {
          const { data, error } = await supabase.rpc('upsert_horse_mind_stats_scoped', {
            rows: [toScopedDb(row)],
          });
          if (error) throw new Error(error.message);
          if (!hasCompleteRowReceipt(data, 1))
            throw new Error('horse_mind_persistence_receipt_unconfirmed');
          recovered++;
        } catch {
          HorseMind.requeueDirtyScoped([row]);
        }
      }
      flushed += recovered;
      failed += chunk.length - recovered;
      reportError(err, 'HorseMindPersistence.flushScoped');
    }
  }
  return { flushed, failed };
}

/** V45 boot hydration of the scoped overlay. Best-effort; returns rows applied. */
export async function hydrateHorseMindScopedFromDb(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('horse_mind_stats_scoped')
      .select(
        'user_id,scope,hands,vpip,pfr,three_bet,aggr,passive,folds,faced_aggr,cbet_opps,cbet_folds,f3b_opps,f3b_folds,bigbet_sd,bigbet_sd_strong,post_aggr,post_passive,river_bet_opps,river_bet_folds,checks,snap_bet_sd,snap_bet_sd_strong,tank_bet_sd,tank_bet_sd_strong'
      )
      .order('hands', { ascending: false })
      .limit(HYDRATE_LIMIT * 3);
    if (error) throw new Error(error.message || 'horse_mind_stats_scoped read failed');
    if (!data || data.length === 0) return 0;
    const applied = HorseMind.importScoped(
      (data as Array<ScopedDbRow>).map((r) => ({
        ...fromDb({ ...r, r_hands: 0, r_folds: 0, r_faced_aggr: 0, r_aggr: 0, r_passive: 0 }),
        scope: r.scope,
        user_id: r.user_id,
      }))
    );
    console.log(`[HorseMind] scoped hydration: ${applied}/${data.length} scoped profiles restored`);
    return applied;
  } catch (err) {
    reportError(err, 'HorseMindPersistence.hydrateScoped');
    return 0;
  }
}

/** Start the periodic flush loop. Idempotent. */
export function startHorseMindPersistence(): void {
  if (flushTimer) return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  flushTimer = setInterval(() => {
    // V12.3: track the in-flight flush. exportDirty() CLEARS the dirty set
    // before the network call, so a shutdown that lands mid-flush used to find
    // an empty set, flush nothing, and exit — losing up to five minutes of
    // learning. stopHorseMindPersistence() now awaits this first.
    const generation = lifecycleGeneration;
    if (!lifecycleActive || inFlightFlushes.size > 0) return;
    let tracked!: Promise<void>;
    tracked = (async () => {
      if (!lifecycleActive || lifecycleGeneration !== generation) return;
      await Promise.all([flushHorseMind(), flushHorseMindPairs(), flushHorseMindScoped()]);
    })().finally(() => {
      inFlightFlushes.delete(tracked);
    });
    inFlightFlushes.add(tracked);
  }, FLUSH_INTERVAL_MS);
  // Never keep the process alive just to flush horse memory.
  flushTimer.unref?.();
}

/** Final best-effort flush for graceful shutdown (bounded by caller's race). */
export async function stopHorseMindPersistence(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Let any in-flight cycle finish before draining, or its already-cleared
  // dirty entries are lost.
  stopOperation = (async () => {
    while (inFlightFlushes.size > 0) {
      await Promise.allSettled([...inFlightFlushes]);
    }
    // Run all three together: sequential awaits inside the caller's old
    // shutdown race meant the pair flush was always the first sacrificed.
    await Promise.all([flushHorseMind(), flushHorseMindPairs(), flushHorseMindScoped()]);
  })();
  return stopOperation;
}
