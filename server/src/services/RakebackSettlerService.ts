/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RAKEBACK SETTLER SERVICE — Periodic Per-Player Rake Aggregator (Daemon)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * BUG ORIGIN (2026-04-15 live verification):
 *   The in-memory rake accumulator inside RakebackEngine.recordHandRake is never
 *   flushed because settleRakeback() has zero callers. Result: rakeback_periods
 *   table is empty (0 rows in 7 days) even though rake_history has 6,869 hands
 *   recorded ($30,136.94 in rake). Players never see accumulated rakeback in UI;
 *   weekly settlement flow has no rows to settle. If the engine restarts, the
 *   in-memory accumulator is lost.
 *
 * FIX:
 *   This daemon runs every 30 minutes. For each completed hand in rake_records
 *   that hasn't been settled yet, it derives the per-player rake credit under
 *   the methodology the hand was SETTLED with (rake_records.rake_method) and
 *   upserts rakeback_periods rows by (user_id, club_id, period_start_week).
 *   Idempotent: re-running over already-settled hands has no effect.
 *
 * ATTRIBUTION (Dan 2026-08-29, BINDING — supersedes DECISION D-001 / FIX 144):
 *   New cash hands use WEIGHTED CONTRIBUTED rake — a player's credit is
 *   proportional to their eligible contribution to the rakeable pot. Rows
 *   stamped DEALT_EQUAL (historical, plus any settled by a pre-deploy engine)
 *   keep reproducing their historical equal split. The single source of the
 *   share math is services/rakeAllocation.ts (SQL twin:
 *   fn_allocate_rake_credits) — never re-derive shares here.
 *
 * SAFETY:
 *   - Reads only from rake_records (durable per-hand audit log)
 *   - Writes only to rakeback_periods (no chip movement)
 *   - Idempotent via period-week bucketing + ON CONFLICT update
 *   - 30-minute interval; can be tuned per traffic
 *
 * RELATED:
 *   - Dan 2026-08-29: weighted contributed rake law (this file's split logic)
 *   - .memory/decisions/001-rake-equal-share.md (SUPERSEDED, kept as history)
 *   - .memory/problems/008-rakeback-settler-missing.md
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { reportError } from './errorReporter.js';
import { sharesForRakeRecord, sharesForRakeRecordWithLedger } from './rakeAllocation.js';
import {
  ATTRIBUTION_PAGE_SIZE,
  readRakeAttributionLedger,
  assertCashAttributionComplete,
} from './rakeAttributionLedger.js';

const SETTLEMENT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
/**
 * How soon to resume when a cycle ended with backlog still outstanding.
 * Deliberately short: the work is identical and already bounded per cycle by
 * MAX_DRAIN_BATCHES, so this only removes dead waiting.
 */
const CATCH_UP_DELAY_MS = 60 * 1000; // 1 minute
/**
 * How many per-player credits to hand the server in one batched call.
 *
 * MEASURED 2026-08-19: the settler was LOSING GROUND — over a 56-minute
 * window the durable cursor advanced 14.1 minutes of history while 56 minutes
 * of new history arrived, and the backlog grew from 286,049 to 287,786 rows.
 * The database was never the constraint: a 2,000-row page issued ONE HTTP
 * round trip PER PLAYER PER HAND, twice (commission + player_stats), i.e.
 * ~24,000 sequential PostgREST calls at a measured ~6/sec. That is over an
 * hour of pure network latency for a page whose SQL takes seconds.
 *
 * The credits now go server-side in chunks, so a page costs a handful of
 * round trips instead of ~24,000, removing ~99% of the latency.
 *
 * SIZED FROM PRODUCTION, not guessed: the first deploy used 500 and hit the
 * ~8s statement timeout on the commission batch (five 500s, five
 * "canceling statement due to statement timeout" entries at 23:38). A timeout
 * aborts the whole call, so those items were skipped and the cursor advanced
 * past them. The functions now set their own 300s timeout AND the chunk is
 * 150, so a chunk is comfortably inside even a slow window with headroom.
 */
const CREDIT_BATCH_SIZE = 150;
const DAEMON_KEY = 'rakeback_settler';

/**
 * Rows pulled from rake_records per batch. Exported so the M6 regression suite
 * can build a dataset that genuinely straddles the LIMIT boundary rather than
 * hard-coding a number that could drift away from the real one.
 */
export const FETCH_LIMIT = 1000;
/*
 * ═══ THIS NUMBER MUST NOT EXCEED PostgREST's db-max-rows (1000) ═══
 *
 * THE bug behind the 2-day backlog, found 2026-08-20 by measuring three
 * consecutive pages: each advanced the cursor by EXACTLY 999 rows, whatever
 * FETCH_LIMIT said. PostgREST caps a response at 1,000 rows, so asking for
 * 2,000 (or the previous 10,000) returns ~1,000 — and the drain loop then
 * evaluates `rawPageSize >= FETCH_LIMIT` as FALSE, concludes "fewer rows than
 * I asked for, therefore I am fully caught up", returns 'idle', and sleeps the
 * full 30-minute interval. With 287,000 rows outstanding.
 *
 * So the settler could never drain more than ~1,000 rows per 30 minutes
 * (~2,000/hour) against ~2,900/hour arriving: a permanent structural deficit
 * that no amount of per-call speed could fix, which is why batching the
 * credits and shrinking the page from 10,000 to 2,000 both failed to move it.
 *
 * At 1,000 a full page now reports 'more' truthfully, so the loop drains
 * MAX_DRAIN_BATCHES pages per cycle and scheduleCatchUp() re-arms in 60s while
 * backlog remains. If PostgREST's cap ever drops below this, the same silent
 * stall returns — keep them equal.
 */
/*
 * AUDIT PASS 3 (2026-08-19) — page size reduced 10,000 -> 2,000.
 *
 * The durable cursor is saved ONCE PER PAGE, at the end, because a page is
 * processed in phases (aggregate every row into per-player buckets -> credit
 * agent commissions -> upsert rakeback_periods + player_stats). Saving it
 * mid-page would risk advancing past rows whose aggregate had not been applied
 * yet, which loses a player's credit silently — the one direction this daemon
 * must never fail in. So the page cannot be checkpointed internally; it can
 * only be made SHORTER.
 *
 * That matters because a 10,000-row page takes roughly an hour here: each row
 * fans out into sequential per-player commission RPCs, measured live at ~6/sec.
 * Any engine restart inside that hour discarded the whole page's progress and
 * the next boot restarted the same page from the same cursor. With several
 * deploys in a day the cursor could therefore never advance at all — verified
 * live on 2026-08-19: the cursor sat at 2026-08-17 10:34 with 285,000
 * unprocessed rake_records while cycles ran continuously.
 *
 * At 2,000 rows a page completes in ~10-12 minutes, so the cursor advances
 * several times an hour and a restart costs minutes instead of an hour.
 * Throughput is unchanged — it is bound by the RPC rate, not the page size —
 * because scheduleCatchUp() re-arms in 60s whenever backlog remains, so pages
 * run back-to-back instead of waiting for the 30-minute interval.
 */

/**
 * AUDIT M6: how many FULL batches one cycle will drain before deferring the
 * rest to the next interval.
 *
 * Before this existed, a cycle read at most FETCH_LIMIT rows and then slept 30
 * minutes regardless of how much backlog remained, so recovering from a long
 * outage took one interval per 10,000 records. The cap is deliberately small
 * rather than unbounded: a full batch runs thousands of SEQUENTIAL per-player
 * commission RPCs, so each one is expensive, and an unbounded drain would let a
 * single cycle run for hours while `isSettling` blocks every other cycle
 * behind it. Three batches recovers ~9 hours of downtime per cycle, which is
 * far more than the ~560 records a normal 30-minute cycle produces. When the
 * cap is hit we LOG it — a silently truncated drain reads exactly like a
 * finished one.
 */
export const MAX_DRAIN_BATCHES = 3;

/**
 * AUDIT M6 — the settler's resume position in rake_records.
 *
 * `createdAt` is kept as the RAW PostgREST string, never round-tripped through
 * `new Date()`. Postgres timestamps carry microseconds; `new Date(iso)`
 * truncates to milliseconds, so persisting a Date-derived value stored a
 * cursor that does not correspond to any real row.
 *
 * `id` is null only for a cursor written before this field existed (or when a
 * row somehow arrives without one). A null id means "no tie-break available",
 * and the reader degrades to the old timestamp-only filter for exactly one
 * cycle.
 */
interface RakeCursor {
  createdAt: string;
  id: string | null;
}

/**
 * Outcome of one batch, so the drain loop knows whether to go round again.
 *   'idle'   — fewer than FETCH_LIMIT rows: fully caught up, nothing to drain
 *   'more'   — exactly FETCH_LIMIT rows: the cursor advanced, call again
 *   'halted' - a read or attribution failed: retain the cursor and retry later
 */
type CycleResult = 'idle' | 'more' | 'halted';

/** Commission counts acknowledge inputs; stats counts report new inserts, so
 * a successful idempotent stats replay can acknowledge zero new rows. */
function readAttributionBatchReceipt(
  data: unknown,
  submitted: number,
  countsEveryInput: boolean
): { ok: number; failed: number } {
  const receipt = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('Missing attribution batch receipt');
  }
  const { ok, failed, error, first_error } = receipt as Record<string, unknown>;
  if (
    typeof ok !== 'number' ||
    !Number.isSafeInteger(ok) ||
    ok < 0 ||
    typeof failed !== 'number' ||
    !Number.isSafeInteger(failed) ||
    failed < 0 ||
    ok + failed > submitted ||
    (countsEveryInput && ok + failed !== submitted) ||
    (error !== undefined && error !== null) ||
    (failed === 0 && first_error !== undefined && first_error !== null)
  ) {
    throw new Error('Invalid attribution batch receipt');
  }
  return { ok, failed };
}

/**
 * PostgREST embeds filter values in a comma/parenthesis-delimited grammar, so a
 * value carrying a quote, comma or bracket would change the SHAPE of the
 * filter rather than its value. Both cursor components come from typed
 * Postgres columns (timestamptz, uuid) and cannot contain these characters —
 * this guard exists so that if that ever stops being true the settler falls
 * back to the safe timestamp-only read instead of issuing a malformed or
 * subtly-widened query.
 */
function isFilterSafe(value: string): boolean {
  return !/["',()]/.test(value);
}

/**
 * AUDIT M6 — the composite `(created_at, id)` keyset predicate.
 *
 * Values are DOUBLE-QUOTED: a timestamptz renders as `2026-08-06
 * 20:30:07.941+00`, and both `:` and `+` are meaningful inside a PostgREST
 * filter. Verified against the live REST endpoint before this shipped — the
 * quoted form returns 200, and a malformed filter returns 400, so a green
 * response is real evidence and not a silently ignored parameter.
 */
function keysetFilter(createdAt: string, id: string): string {
  return `created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt."${id}")`;
}

const RAKEBACK_TIERS = [
  { minRake: 0, rakebackPercent: 5, name: 'Bronze' },
  { minRake: 100, rakebackPercent: 10, name: 'Silver' },
  { minRake: 500, rakebackPercent: 15, name: 'Gold' },
  { minRake: 2000, rakebackPercent: 20, name: 'Platinum' },
  { minRake: 10000, rakebackPercent: 30, name: 'Diamond' },
];

/**
 * WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): the per-hand share math lives in
 * services/rakeAllocation.ts and is method-aware — sharesForRakeRecord(row)
 * allocates proportionally to eligible contribution for rows stamped
 * WEIGHTED_CONTRIBUTED and reproduces the historical exact integer-cents equal
 * split for legacy DEALT_EQUAL rows. Values always sum EXACTLY to the row's
 * rake_amount (verified by scripts/verification-harness/
 * 02-weighted-contributed-rake.sql and rakeAllocation.test.ts).
 */

function tierFor(rakeContributed: number): { rate: number; name: string } {
  let chosen = RAKEBACK_TIERS[0];
  for (const tier of RAKEBACK_TIERS) {
    if (rakeContributed >= tier.minRake) chosen = tier;
  }
  return { rate: chosen.rakebackPercent / 100, name: chosen.name };
}

/** Returns the Monday 00:00 UTC of the week containing `d`. */
function weekStart(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun
  const offset = (day + 6) % 7; // days since Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  return monday.toISOString().slice(0, 10);
}

function weekEnd(d: Date): string {
  const day = d.getUTCDay();
  const offset = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  const sunday = new Date(monday.getTime() + 6 * 86400 * 1000);
  return sunday.toISOString().slice(0, 10);
}

interface RakeRecordRow {
  id?: string;
  is_tournament?: boolean | null;
  tournament_id?: string | null;
  hand_id: string;
  club_id: string;
  rake_amount: number;
  player_contributions: Record<string, number> | null;
  /** 'WEIGHTED_CONTRIBUTED' for post-migration cash hands; 'DEALT_EQUAL' legacy. */
  rake_method?: string | null;
  created_at: string;
}

/**
 * TOURNAMENT RAKE IS ATTRIBUTED ONCE, AT SETTLEMENT (Phase 6, 2026-09-07).
 *
 * A rake_records row with is_tournament (or a tournament_id) is an entry fee,
 * a rebuy, a satellite seat or a spin book. fn_settle_tournament_rake ->
 * fn_attribute_tournament_rake credits its VIP, its agent commission and its
 * player_stats when the tournament settles, by metadata.user_id (or spread
 * across the field for a userless row). The per-row paths in this service -
 * agent commission and player_stats - are for CASH hands only. A tournament
 * row that happens to carry player_contributions (spin books do) must not be
 * paid a second time here.
 *
 * The player RAKEBACK basis (fn_rakeback_recompute_periods) is deliberately
 * NOT gated by this: whether tournament fees earn player rakeback is a
 * policy question for Dan (spin books do today, MTT entries do not), and this
 * function changes neither.
 */
export function isTournamentRakeRow(row: {
  is_tournament?: boolean | null;
  tournament_id?: string | null;
}): boolean {
  return row.is_tournament === true || (row.tournament_id != null && row.tournament_id !== '');
}

export class RakebackSettlerService {
  private isRunning = false;
  // SWEEP #4 FIX (2026-07-23): re-entrancy guard. runSettlement() fires every 30 min
  // and once on startup with no "still running" check. A backlog run (up to 10,000
  // rake_records × sequential per-dealt-in-player credit RPCs — easily >30 min after
  // downtime or on a first HWM-less deploy scanning 7 days) overlapped the next tick,
  // which re-read from the same not-yet-advanced watermark and RE-CREDITED every
  // agent_commissions row (the live commission ledger) and re-incremented player_stats.
  // isSettling makes overlapping runs no-op.
  private isSettling = false;
  private intervalHandle: NodeJS.Timeout | null = null;
  // AUDIT M6: was `lastSettledAt: Date | null` — a timestamp alone is not a
  // unique position in rake_records, so it could not express "resume after
  // THIS row" when several rows share one created_at.
  private cursor: RakeCursor | null = null;
  /**
   * AUDIT PASS 3 — backlog catch-up timer. When a cycle stops because it hit
   * MAX_DRAIN_BATCHES there is still backlog on disk, and waiting the full
   * 30-minute interval to resume is what let the cursor fall days behind
   * (measured 2026-08-19: cursor at 2026-08-17 10:34 with 284,965 unprocessed
   * rake_records against only ~2,900 arriving per hour — the daemon had ample
   * capacity and was simply idling between batches). Instead we re-arm in
   * CATCH_UP_DELAY_MS. Same work, same batch semantics, just sooner.
   */
  private catchUpHandle: ReturnType<typeof setTimeout> | null = null;
  /**
   * Timer handles only describe future work. Settlement, financial-close and
   * conservation passes which already started keep mutating shared ledgers
   * after clearInterval/clearTimeout. Keep explicit ownership until every
   * admitted promise and continuation has settled.
   */
  private readonly lifecycleJobs = new Set<Promise<unknown>>();
  private lifecycleGeneration = 0;
  private stopOperation: Promise<void> | null = null;
  /**
   * Direct runSettlement() calls are supported by diagnostics before start,
   * but once stop fences this instance they stay refused until start opens a
   * new generation. That closes the small post-stop admission race where an
   * external caller could otherwise register work after an empty drain.
   */
  private acceptingSettlements = true;

  private lifecycleIsCurrent(generation: number): boolean {
    return this.isRunning && this.lifecycleGeneration === generation;
  }

  private trackLifecycleJob<T>(job: Promise<T>): Promise<T> {
    const tracked = job.finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
    return tracked;
  }

  private openLifecycleScope(): () => void {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    void this.trackLifecycleJob(completion);
    return release;
  }

  private launchSettlement(generation: number, context: string): void {
    if (!this.lifecycleIsCurrent(generation)) return;
    void this.trackLifecycleJob(this.runSettlement()).catch((e: any) =>
      reportError(new Error(e?.message || JSON.stringify(e) || String(e)), context)
    );
  }

  private async drainLifecycleJobs(): Promise<void> {
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  start(): void {
    if (this.stopOperation) {
      console.warn('[RakebackSettler] Start refused while the prior generation is stopping');
      return;
    }
    if (this.isRunning) {
      console.log('[RakebackSettler] Already running');
      return;
    }
    this.isRunning = true;
    this.acceptingSettlements = true;
    const generation = ++this.lifecycleGeneration;
    console.log(`[RakebackSettler] Starting (interval: ${SETTLEMENT_INTERVAL_MS / 60000}m)`);
    // Run once immediately on startup, then every 30 min
    this.launchSettlement(generation, 'RakebackSettler.startup_run');
    this.intervalHandle = setInterval(() => {
      // THE FREEZE (Dan 2026-09-01): settlement credits commissions and
      // rakeback - chip movement by definition. A 30-minute cadence loses
      // nothing to a 5-minute wait.
      if (isMaintenanceFrozen()) return;
      this.launchSettlement(generation, 'RakebackSettler.interval_run');
    }, SETTLEMENT_INTERVAL_MS);
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;

    // Fence admission synchronously. GameServer can invoke every producer's
    // stop first, then await the returned promises before releasing leadership.
    this.isRunning = false;
    this.acceptingSettlements = false;
    this.lifecycleGeneration++;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.catchUpHandle) {
      clearTimeout(this.catchUpHandle);
      this.catchUpHandle = null;
    }

    const drain = (async () => {
      await this.drainLifecycleJobs();
      console.log('[RakebackSettler] Stopped');
    })();
    const trackedStop = drain.finally(() => {
      if (this.stopOperation === trackedStop) this.stopOperation = null;
    });
    this.stopOperation = trackedStop;
    return trackedStop;
  }

  /**
   * AUDIT PASS 3 — re-arm quickly while backlog remains.
   *
   * Only ever ONE pending catch-up (cleared and re-set each time), it is a
   * no-op unless the last cycle actually hit the drain cap, and the run it
   * triggers goes through the same `isSettling` re-entrancy guard as the
   * interval tick — so this cannot double-process or stack timers. The regular
   * 30-minute interval keeps running underneath as the floor.
   */
  private scheduleCatchUp(backlogRemains: boolean, generation: number | null): void {
    if (this.catchUpHandle) {
      clearTimeout(this.catchUpHandle);
      this.catchUpHandle = null;
    }
    if (!backlogRemains || generation === null || !this.lifecycleIsCurrent(generation)) {
      return;
    }
    this.catchUpHandle = setTimeout(() => {
      this.catchUpHandle = null;
      this.launchSettlement(generation, 'RakebackSettler.catch_up_run');
    }, CATCH_UP_DELAY_MS);
    // Never hold the process open for a catch-up tick.
    (this.catchUpHandle as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Load the durable high-water-mark so a restart resumes exactly where the last
   * run stopped instead of re-scanning the 7-day fallback window (which would
   * re-increment player_stats for already-settled hands).
   */
  private async loadHighWaterMark(): Promise<{ ok: boolean; value: RakeCursor | null }> {
    // RAKE-AUDIT 2026-07-24: distinguish "no watermark row yet" (genuine first
    // run → 7-day fallback is correct) from "read FAILED" (transient DB error).
    // The old signature collapsed both to null, so a transient failure at
    // startup silently re-scanned 7 days and re-incremented the NON-idempotent
    // player_stats accumulators (agent_commissions are safe — the RPC dedupes
    // on (user_id, source_id, source_type)). On a failed read the caller now
    // ABORTS the cycle and retries next interval instead of double-crediting.
    //
    // AUDIT M6: the timestamp is returned as the RAW string the database sent.
    // The old code did `new Date(data.high_water_mark)`, which silently dropped
    // the microsecond component of every Postgres timestamp — the cursor then
    // pointed at an instant no row actually occupies.
    try {
      const { data, error } = await supabase
        .from('daemon_state')
        .select('high_water_mark, high_water_mark_id')
        .eq('daemon', DAEMON_KEY)
        .maybeSingle();
      if (error) return { ok: false, value: null };
      if (!data?.high_water_mark) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          createdAt: String(data.high_water_mark),
          id: data.high_water_mark_id ? String(data.high_water_mark_id) : null,
        },
      };
    } catch {
      return { ok: false, value: null };
    }
  }

  /** Persist the cursor durably (survives engine restarts). */
  private async saveHighWaterMark(cursor: RakeCursor): Promise<void> {
    try {
      await supabase.from('daemon_state').upsert(
        {
          daemon: DAEMON_KEY,
          high_water_mark: cursor.createdAt,
          high_water_mark_id: cursor.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'daemon' }
      );
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.saveHighWaterMark'
      );
    }
  }

  /** Thin wrapper around supabase.rpc returning {error} for cleaner control flow. */
  private async supabaseRpc(name: string, args: Record<string, unknown>) {
    try {
      const { error } = await supabase.rpc(name, args);
      return { error };
    } catch (e) {
      return { error: e };
    }
  }

  /**
   * Aggregates rake_records since the last settlement (or last 7 days on first
   * run) into per-player rakeback_periods rows. Idempotent.
   */
  async runSettlement(): Promise<void> {
    if (!this.acceptingSettlements) {
      console.warn('[RakebackSettler] Settlement refused after service stop');
      return;
    }
    // Public acceptance probes and any future direct caller must be part of
    // the same stop proof as timer-launched runs. The launcher also tracks its
    // returned promise; this scope owns the continuation from method entry.
    const releaseLifecycle = this.openLifecycleScope();
    const generation = this.isRunning ? this.lifecycleGeneration : null;
    try {
      // SWEEP #4: skip if a previous run is still in flight (prevents the double-credit
      // described on the isSettling field). The guard wraps the whole run in try/finally
      // so the flag always clears even on a thrown error.
      if (this.isSettling) {
        console.warn('[RakebackSettler] settlement already in progress - skipping overlapping run');
        return;
      }
      this.isSettling = true;
      try {
        // AUDIT M6: drain the backlog instead of processing one batch and then
        // sleeping 30 minutes. `_runSettlementInner` advances the durable cursor
        // before returning 'more', so each pass through this loop starts strictly
        // after the last row of the previous one - an interruption anywhere in
        // the loop resumes correctly rather than replaying.
        let backlogRemains = false;
        for (let batch = 1; ; batch++) {
          const result = await this._runSettlementInner();
          if (result !== 'more') break;
          if (batch >= MAX_DRAIN_BATCHES) {
            backlogRemains = true;
            console.warn(
              `[RakebackSettler] drain cap reached after ${batch} full batches ` +
                `(${batch * FETCH_LIMIT} records) - backlog REMAINS, resuming in ` +
                `${CATCH_UP_DELAY_MS / 1000}s instead of waiting the full interval`
            );
            break;
          }
        }
        this.scheduleCatchUp(backlogRemains, generation);
        // RAKE-AUDIT 2026-07-24: weekly financial close now runs SERVER-SIDE.
        // Previously the weekly rakeback settlement + credit-invoice generation
        // lived only in the browser (FinancialCronService/SettlementCronService
        // setInterval), so they fired ONLY while an admin had a tab open.
        // AUDIT PASS 3 [ORDER + CADENCE]: the union's weekly 90% must land BEFORE
        // runWeeklyFinancialClose() pays player rakeback, because player rakeback
        // is now funded from clubs.chip_treasury and the union payback is what
        // replenishes it - running them the other way round deferred every
        // player payout by a week on the first close. It also runs EVERY cycle
        // rather than inside the once-a-week gate: the RPC is idempotent and
        // no-ops mid-week, so a close that fails (or an engine outage spanning a
        // Monday) is retried within 30 minutes instead of 7 days.
        await this.runUnionWeeklyRakeback();
        // Player rakeback, every cycle. See runRakebackDrain: settle_club_rakeback
        // is bounded, so it must be drained in a loop rather than called once a
        // week. Ordered after the union 90% because that is what funds it.
        await this.runRakebackDrain();
        await this.runWeeklyFinancialClose();

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  THE SENTINELS MUST NOT STARVE THE DRAIN (2026-09-09)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Everything ABOVE this line moves money and stays inside `isSettling`.
         * Everything BELOW it reports rather than settles - and two of those
         * RPCs, `fn_union_treasury_selftest` and `fn_union_rake_rollup_catchup_all`,
         * reliably hit `canceling statement due to statement timeout` on this
         * database, which costs the full timeout before they fail.
         *
         * That is what made `scheduleCatchUp()` useless. It armed its 60-second
         * retry above, the retry fired while this tail was still burning
         * timeouts, hit the `isSettling` guard at the top of this method, and
         * logged "settlement already in progress - skipping overlapping run".
         * The catch-up never caught up: the drain ran once per THIRTY-MINUTE
         * interval instead.
         *
         * Measured 2026-09-09: a page of 999 records takes 22-28s, so three
         * batches is ~75s and the drain's real capacity is ~80,000 records/hour
         * against ~6,000/hour arriving. Yet the settler sat 10.3 hours behind
         * with a 60,870-row backlog, gaining only 1.65x real time - because
         * 3,000 records per 30 minutes IS 6,000/hour, exactly the inflow. It
         * could never gain, and any hiccup lost ground for good.
         *
         * So while there is backlog, the read-only sentinels are skipped. They
         * are idempotent, they run on the next cycle once the queue is clear,
         * and draining a player's rakeback outranks re-checking an invariant.
         */
        if (backlogRemains) {
          console.log(
            '[RakebackSettler] backlog remains - deferring the read-only sentinels so the drain keeps the floor'
          );
          return;
        }
        // SWEEP #6: post-tournament money-conservation sentinel. Scans every
        // tournament that reached COMPLETED since the last cycle and asserts the
        // invariants that the whole rake/payout audit is meant to guarantee, so a
        // future regression that mints chips, strands players, or wrongly rakes a
        // tournament hand is caught within one settler cycle instead of silently
        // corrupting the ledger. Never mutates game state - reportError only.
        await this.runTournamentSentinel();
        // AUDIT 2026-08-19: union treasury conservation sentinel - one cheap RPC
        // per cycle; breaches land in financial_alerts (deduped) and telemetry.
        await this.runUnionTreasurySentinel();
        // P3-1 2026-08-20: governance + settlement-conservation invariants now
        // run every settler cycle instead of only inside Monday's PHASE 8 on
        // the workers. Every rule they enforce fails silently as data drift; a
        // weekly-only check means up to seven days of unnoticed breakage.
        // reportError only - never mutates state. Monday's PHASE 8 still
        // notifies the union owner/admins for critical breaks.
        await this.runUnionGovernanceSentinel();
        // 2026-08-20: keep the union rake rollup warm OUTSIDE the money
        // transaction. The rollup is filled lazily by its first caller, and on
        // Monday that caller is fn_union_settle_player_pnl while it holds
        // FOR UPDATE locks on union_wallets and clubs.chip_treasury - the same
        // rows live horse funding writes to. Measured 2026-08-20: 4 unrolled
        // days would have added ~12s of scan inside that lock window. This
        // also RE-ROLLS days whose inputs changed retroactively (the union
        // migration keeps setting tables.union_id on existing tables, which
        // pulls historical rake_records into scope after a day was finalized).
        await this.runUnionRakeRollupCatchup();
        // 2026-08-20: persist this week's ECO (union win tax / loss rebate) so an
        // invoice issued today can be reproduced tomorrow after live data moves
        // on. Idempotent per (union, club, week) and a complete no-op while ECO
        // is disabled, which it is by default. Deliberately NOT inside the
        // settlement transaction: it reads the reconciliation report (~7s over a
        // week) and that must never run while FOR UPDATE locks are held on
        // union_wallets and clubs.chip_treasury.
        await this.runUnionEcoRecord();
        // PAYOUT-INTEGRITY 2026-08-20: a live tournament must hold exactly the
        // chips it issued. Nothing verified this before.
        await this.runTournamentChipConservation();
      } finally {
        this.isSettling = false;
      }
    } finally {
      releaseLifecycle();
    }
  }

  /**
   * SWEEP #6 — Tournament invariant sentinel.
   *
   * For each tournament newly observed as COMPLETED (watermarked by ended_at in
   * daemon_state under 'tournament_sentinel'), verify:
   *
   *   (1) PAYOUT CONSERVATION — for non-satellite events, the sum of paid
   *       tournament_players.prize must equal tournaments.prize_pool within a small
   *       rounding tolerance. A shortfall means chips were destroyed (players not
   *       paid); an overage means chips were minted. Satellite events pay tickets,
   *       not the cash pool, so they are exempt from this check.
   *
   *   (2) NO STRANDED PLAYERS — a COMPLETED tournament must have zero rows still in
   *       'playing'/'registered'/'active'. A stranded row is a lost seat/refund and
   *       the exact class of regression the sweep-4/5 cleanup helpers fixed.
   *
   *   (3) NO RAKED TOURNAMENT HANDS — the pot engine must take zero rake during
   *       tournament play (the only tournament money is the 10% entry fee, which is
   *       logged with hand_id NULL). Any rake_records row for this tournament with a
   *       hand_id AND positive rake_amount means the tournament rake-config gate
   *       regressed.
   *
   * Idempotent and cheap: bounded batch per cycle, advances the watermark to the
   * newest processed ended_at so each tournament is checked once.
   *
   * THE WINDOW COLUMN WAS WRONG UNTIL 2026-08-31, in exactly the way the retired
   * payout sweep's was until 2026-08-29. This scan
   * filtered, ordered and watermarked on `tournaments.updated_at`, which NOTHING
   * maintains — no trigger, no engine write. Measured on 2026-08-31: 2,286 of
   * 2,286 tournaments created in 24 hours had `updated_at = created_at`, and
   * `updated_at < started_at` on every one.
   *
   * So the watermark was a CREATION time, and the batch advanced it past every
   * lobby created before the one it happened to finish on. A tournament created
   * before the mark and finished after it was never checked — not late, never.
   * Measured at the live watermark (14:47:57, itself the creation time of a spin
   * that had just completed): 63 COMPLETED events created before it and ended
   * after it, 44 of them Spins, none of which this sentinel had looked at. That
   * recurs on every batch, so it is a permanent blind spot for anything that
   * finishes out of creation order — which, for lobbies opened minutes to hours
   * before they fill, is most of the board.
   *
   * What went unchecked is the point: payout conservation (chips destroyed or
   * minted), stranded players, and raked tournament hands.
   *
   * `ended_at` is the honest column here — "newly observed as COMPLETED" means
   * finished, not scheduled — and it is safe to order on: it is set on 100% of
   * the 43,482 events COMPLETED in the last 30 days.
   */
  private async runTournamentSentinel(): Promise<void> {
    const SENTINEL_KEY = 'tournament_sentinel';
    const BATCH = 100;
    try {
      const { data: state, error: stateErr } = await supabase
        .from('daemon_state')
        .select('high_water_mark')
        .eq('daemon', SENTINEL_KEY)
        .maybeSingle();
      if (stateErr) {
        console.warn('[TournamentSentinel] watermark read failed - skipping cycle');
        return;
      }
      // Epoch fallback on genuine first run so we don't rescan all history at once;
      // start from 24h ago to catch anything that completed around first boot.
      const sinceIso = state?.high_water_mark
        ? new Date(state.high_water_mark).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: tourneys, error: tErr } = await supabase
        .from('tournaments')
        .select('id, name, prize_pool, variant, satellite_target_id, ended_at')
        .eq('status', 'COMPLETED')
        .gt('ended_at', sinceIso)
        .order('ended_at', { ascending: true })
        .limit(BATCH);
      if (tErr) {
        console.warn(`[TournamentSentinel] tournament read failed: ${tErr.message}`);
        return;
      }
      if (!tourneys || tourneys.length === 0) return;

      let newWatermark = sinceIso;
      let violations = 0;

      for (const t of tourneys as Array<{
        id: string;
        name: string | null;
        prize_pool: number | null;
        variant: string | null;
        satellite_target_id: string | null;
        ended_at: string;
      }>) {
        if (t.ended_at > newWatermark) newWatermark = t.ended_at;
        // Pool-equality is only meaningful for events where the ENTIRE cash pool
        // flows through tournament_players.prize. It does NOT hold for:
        //   • satellites — they pay tickets/seats, not the cash pool;
        //   • bounty / PKO / mystery — the bounty slice is paid to knockers through
        //     a separate bounty ledger, so tp.prize only holds the non-bounty pool.
        // These are exempt from check (1) but still checked for stranded players and
        // raked hands.
        const variant = (t.variant ?? '').toLowerCase();
        const skipPoolCheck =
          variant === 'satellite' ||
          !!t.satellite_target_id ||
          variant === 'bounty' ||
          variant === 'pko' ||
          variant === 'progressive_ko' ||
          variant === 'mystery' ||
          variant === 'mystery_bounty';

        // (1) Payout conservation (full-cash-pool events only).
        if (!skipPoolCheck) {
          const { data: prizeRows, error: pErr } = await supabase
            .from('tournament_players')
            .select('prize')
            .eq('tournament_id', t.id)
            .gt('prize', 0);
          if (!pErr) {
            const paid = (prizeRows ?? []).reduce(
              (s, r) => s + (Number((r as { prize: number | null }).prize) || 0),
              0
            );
            const pool = Number(t.prize_pool) || 0;
            // Tolerance: 1 currency unit or 1% of pool, whichever is larger, to
            // absorb legitimate per-position rounding without masking real leaks.
            const tolerance = Math.max(1, pool * 0.01);
            if (pool > 0 && Math.abs(paid - pool) > tolerance) {
              violations++;
              reportError(
                new Error(
                  `Tournament payout conservation breach: tournament ${t.id} (${t.name ?? 'unnamed'}) ` +
                    `paid ${paid.toFixed(2)} vs prize_pool ${pool.toFixed(2)} (diff ${(paid - pool).toFixed(2)}, tol ${tolerance.toFixed(2)})`
                ),
                'TournamentSentinel.payout_conservation',
                { tournamentId: t.id, paid, pool }
              );
            }
          }
        }

        // (2) No stranded players.
        {
          const { count, error: sErr } = await supabase
            .from('tournament_players')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .in('status', ['playing', 'registered', 'active']);
          if (!sErr && (count ?? 0) > 0) {
            violations++;
            reportError(
              new Error(
                `Stranded players on COMPLETED tournament ${t.id} (${t.name ?? 'unnamed'}): ${count} row(s) still active`
              ),
              'TournamentSentinel.stranded_players',
              { tournamentId: t.id, stranded: count }
            );
          }
        }

        // (3) No raked tournament hands.
        {
          const { count, error: rErr } = await supabase
            .from('rake_records')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .not('hand_id', 'is', null)
            .gt('rake_amount', 0);
          if (!rErr && (count ?? 0) > 0) {
            violations++;
            reportError(
              new Error(
                `Raked tournament hands detected for tournament ${t.id} (${t.name ?? 'unnamed'}): ${count} hand(s) with positive rake`
              ),
              'TournamentSentinel.raked_tournament_hands',
              { tournamentId: t.id, rakedHands: count }
            );
          }
        }
      }

      // Advance watermark so processed tournaments are not re-scanned. Only writes
      // forward — a same-timestamp batch boundary is handled by the strict `>` read
      // filter (worst case a tournament is re-checked once, which is harmless).
      await supabase.from('daemon_state').upsert(
        {
          daemon: SENTINEL_KEY,
          high_water_mark: newWatermark,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'daemon' }
      );
      console.log(
        `[TournamentSentinel] checked ${tourneys.length} completed tournament(s), ${violations} violation(s), watermark → ${newWatermark}`
      );
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'TournamentSentinel.cycle'
      );
    }
  }

  /**
   * RAKE-AUDIT 2026-07-24: Server-authoritative weekly financial close.
   * Once per ISO week (first settler cycle on/after Monday 00:00 UTC):
   *   1. settle_club_rakeback for every club with pending LAPSED rakeback
   *      periods (the RPC pays each player's rakeback into their wallet and
   *      marks the period paid; a guard in the RPC skips still-open weeks).
   *   2. fn_generate_all_credit_invoices — weekly agent credit invoices.
   *   3. Reset agents.weekly_rake_generated for the new week (the commission
   *      RPC accumulates it; nothing ever reset it, so "weekly" grew forever).
   * Idempotent via a daemon_state watermark keyed to the week's Monday date —
   * every step is also individually idempotent (paid periods are skipped,
   * invoices dedupe), so a crash mid-close is safe to re-run.
   */
  /**
   * AUDIT 2026-08-19 — Union treasury conservation sentinel.
   * fn_union_treasury_selftest() verifies: non-negative wallets, the
   * rake_wallet <= chip_balance sub-account invariant, audit-ledger
   * reconciliation of the rake treasury, BBJ (pool,hand) uniqueness, retired
   * pools holding zero, and that no fully-lapsed week is unclosed. The RPC
   * writes deduped financial_alerts rows itself; we also reportError so a
   * breach surfaces in engine telemetry within one settler cycle.
   */
  private async runUnionTreasurySentinel(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_union_treasury_selftest', {});
      if (error) {
        reportError(
          new Error(`fn_union_treasury_selftest failed: ${error.message}`),
          'RakebackSettler.treasury_selftest_rpc'
        );
        return;
      }
      const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (r && r.healthy === false) {
        reportError(
          new Error(`UNION TREASURY CONSERVATION BREACH: ${JSON.stringify(r.breaches)}`),
          'RakebackSettler.treasury_selftest_breach'
        );
      }
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.treasury_selftest_threw'
      );
    }
  }

  /**
   * Persist the current week's ECO adjustment (2026-08-20).
   *
   * ECO is an INVOICE ADJUSTMENT with no automatic chip distribution; this
   * only writes the computed figure to union_eco_ledger so the weekly invoice
   * stays reproducible. No-ops entirely unless a union has eco_enabled set.
   */
  /**
   * Tournament chip conservation.
   *
   * Chips in play must equal
   *   players x starting_chips + rebuys x rebuy_chips + add-ons x addon_chips
   *
   * Measured when this was written: 5 of 7 RUNNING tournaments exact to the
   * chip, and the two MULTI-TABLE ones carrying a small excess -- Prime Time
   * Main Event +261 on 2.19m (0.012%) and Evening Mystery Bounty +100 on
   * 300k (0.033%). Those same two are the only tournaments holding FRACTIONAL
   * seat stacks, which a tournament should never have: the hand engine splits
   * pots to two decimals like cash money, so a tournament accumulates
   * fractional chips at every odd-chip split.
   *
   * The drift is constant rather than per-hand (it stayed at ~258-261 while
   * rebuys went 65 -> 67 and hands reached 1,194), and a 200,000-hand fuzz of
   * the chip-conservation property test surfaced only an eligibility
   * misallocation, never net creation -- so this is not yet root-caused and
   * is reported, not corrected. Reporting it every cycle is what turns it
   * from something found by hand into something that cannot hide.
   *
   * Tolerance is per player, so pure integer-flooring noise does not alarm.
   */
  private async runTournamentChipConservation(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_tournament_chip_conservation_check', {
        p_tolerance_per_player: 1,
      });
      if (error) {
        reportError(
          new Error(`fn_tournament_chip_conservation_check failed: ${error.message}`),
          'RakebackSettler.tournament_chip_conservation_rpc'
        );
        return;
      }
      const rows = (data ?? []) as Array<{
        name?: string;
        players?: number;
        expected_chips?: number;
        actual_chips?: number;
        drift?: number;
      }>;
      if (rows.length > 0) {
        reportError(
          new Error(
            `TOURNAMENT CHIPS: ${rows.length} live tournament(s) do not hold the chips they issued - ` +
              rows
                .map(
                  (r) =>
                    `${r.name}: ${r.actual_chips} vs ${r.expected_chips} expected (drift ${r.drift} over ${r.players} players)`
                )
                .join('; ')
                .slice(0, 1200)
          ),
          'RakebackSettler.tournament_chip_drift'
        );
      }
    } catch (err) {
      reportError(err, 'RakebackSettler.tournament_chip_conservation_threw');
    }
  }

  private async runUnionEcoRecord(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_union_eco_record_current_week', {});
      if (error) {
        reportError(
          new Error(`fn_union_eco_record_current_week failed: ${error.message}`),
          'RakebackSettler.eco_record_rpc'
        );
        return;
      }
      const unions = ((data as { unions?: unknown[] } | null)?.unions ?? []) as Array<{
        success?: boolean;
        clubs?: number;
        error?: string;
        union_id?: string;
      }>;
      for (const u of unions) {
        if (u?.success === false) {
          reportError(
            new Error(`ECO record failed for ${u.union_id}: ${u.error}`),
            'RakebackSettler.eco_record_failed'
          );
        } else if ((u?.clubs ?? 0) > 0) {
          console.log(`[RakebackSettler] ECO recorded for ${u.clubs} club(s)`);
        }
      }
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.eco_record_threw'
      );
    }
  }

  /**
   * Union rake rollup catch-up (2026-08-20).
   *
   * fn_union_rake_rollup_catchup_all() finalizes up to 3 missing-or-stale
   * whole UTC days per union per cycle, each in its own transaction under an
   * advisory lock. Bounded by construction (~3s per day) and safe to run
   * concurrently with play. Correctness never depends on it: a stale day is
   * detected by record-count mismatch and recomputed live at read time. This
   * is purely to keep that work OUT of the Monday settlement transaction.
   */
  // Deploy note: runs for 43a7ce579 and f0a61596f both failed in ~4s with zero
  // steps executed. Cause was account-level: GitHub Actions was blocked by the
  // billing/spending limit from ~12:22 to ~12:55 UTC on 2026-08-20, which
  // failed every workflow in every repo instantly. Not a code failure — tsc
  // clean and 848/848 server tests green throughout. Deployed once the budget
  // was raised.
  private async runUnionRakeRollupCatchup(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_union_rake_rollup_catchup_all', {
        p_max_days: 3,
      });
      if (error) {
        reportError(
          new Error(`fn_union_rake_rollup_catchup_all failed: ${error.message}`),
          'RakebackSettler.rake_rollup_catchup_rpc'
        );
        return;
      }
      const unions = ((data as { unions?: unknown[] } | null)?.unions ?? []) as Array<{
        union_id: string;
        rolled: string[];
        failed: string[];
        stale_remaining: number;
      }>;
      for (const u of unions) {
        if ((u.failed?.length ?? 0) > 0) {
          reportError(
            new Error(`union rake rollup failed for ${u.union_id}: ${JSON.stringify(u.failed)}`),
            'RakebackSettler.rake_rollup_catchup_failed'
          );
        }
        if ((u.rolled?.length ?? 0) > 0) {
          console.log(
            `[RakebackSettler] Union rake rollup: ${u.union_id} rolled ` +
              `${u.rolled.join(', ')} (stale remaining: ${u.stale_remaining})`
          );
        }
      }
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.rake_rollup_catchup_threw'
      );
    }
  }

  /**
   * P3-1 (2026-08-20) — Union governance + settlement conservation sentinel.
   *
   * Runs fn_union_governance_check() and fn_settlement_conservation_check()
   * once per settler cycle (30 min). Both return one row per BROKEN
   * invariant; an empty result is a healthy system. Any row is surfaced to
   * engine telemetry via reportError so drift is visible within one cycle
   * instead of at the next Monday close. Read-only: never mutates state.
   */
  private async runUnionGovernanceSentinel(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_union_governance_check', {});
      if (error) {
        reportError(
          new Error(`fn_union_governance_check failed: ${error.message}`),
          'RakebackSettler.governance_sentinel_rpc'
        );
      } else {
        for (const v of (data ?? []) as Array<{
          invariant: string;
          severity: string;
          offenders: number;
          detail: string;
        }>) {
          reportError(
            new Error(
              `UNION GOVERNANCE ${String(v.severity).toUpperCase()} ${v.invariant}: ` +
                `${v.detail} (${v.offenders} affected)`
            ),
            'RakebackSettler.governance_sentinel_breach'
          );
        }
      }
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.governance_sentinel_threw'
      );
    }
    try {
      const { data, error } = await supabase.rpc('fn_settlement_conservation_check', {});
      if (error) {
        reportError(
          new Error(`fn_settlement_conservation_check failed: ${error.message}`),
          'RakebackSettler.conservation_sentinel_rpc'
        );
      } else {
        for (const c of (data ?? []) as Array<{
          issue: string;
          severity: string;
          detail: string;
        }>) {
          reportError(
            new Error(
              `SETTLEMENT CONSERVATION ${String(c.severity).toUpperCase()} ` +
                `${c.issue}: ${c.detail}`
            ),
            'RakebackSettler.conservation_sentinel_breach'
          );
        }
      }
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.conservation_sentinel_threw'
      );
    }
  }

  /**
   * AUDIT PASS 3 — Union weekly 90/10 rakeback, run every settler cycle.
   *
   * Dan's spec: rake is HELD in union_wallets.rake_wallet during the week; at
   * close, 90% goes back to each member club's chip_treasury and the union
   * keeps 10%. fn_union_weekly_rakeback_close_all closes EVERY unclosed lapsed
   * ISO week, so any missed Monday self-heals. Treasury-funded, idempotent per
   * (union, period), service_role only; insufficient-treasury rejections raise
   * durable financial_alerts inside the RPC. Mid-week this is a no-op.
   */
  private async runUnionWeeklyRakeback(): Promise<void> {
    let result: unknown = null;
    let rpcError: unknown = null;
    try {
      const res = await supabase.rpc('fn_union_weekly_rakeback_close_all', {});
      result = res.data;
      rpcError = res.error;
    } catch (e) {
      rpcError = e;
    }
    if (rpcError) {
      reportError(
        new Error(`fn_union_weekly_rakeback_close_all failed: ${JSON.stringify(rpcError)}`),
        'RakebackSettler.weekly_union_rakeback'
      );
      return;
    }
    const r = (Array.isArray(result) ? result[0] : result) as Record<string, unknown> | null;
    const closes = (r?.closes ?? []) as unknown[];
    if (closes.length > 0) {
      console.log(`[RakebackSettler] Union weekly rakeback: ${JSON.stringify(closes)}`);
    }
  }

  /**
   * PLAYER RAKEBACK DRAIN - every cycle, not once a week (2026-09-07).
   *
   * settle_club_rakeback became BOUNDED on 2026-09-07: it settles at most 40
   * periods and stops after ~4s of wall clock. It had to be - the unbounded
   * version could not finish a 1,769-period backlog inside the 8s
   * statement_timeout service_role carries, so it was cancelled every Monday
   * and had settled nothing since 2026-08-20 while 443,513.92 sat owed to
   * 1,005 players.
   *
   * A bound puts an obligation on the caller: DRAIN IN A LOOP. This used to be
   * step 1 of runWeeklyFinancialClose, which sits behind a once-per-ISO-week
   * gate and stamps the week closed whether or not anything drained - so one
   * bounded pass per club would have paid 40 periods and then latched for
   * seven days.
   *
   * So it moves here, for the reason the comment above runUnionWeeklyRakeback
   * already gives: the RPC is idempotent and no-ops when nothing is due, so a
   * club not finished this cycle is finished 30 minutes later instead of next
   * Monday. It runs AFTER the union 90% lands, because player rakeback is
   * funded from clubs.chip_treasury and the union payback is what fills it.
   *
   * It reads the response. supabaseRpc() discards `data`, and a refusal comes
   * back as HTTP 200 with success:false - so a call that settles nothing
   * because it was not authorised is invisible unless somebody looks.
   */
  private async runRakebackDrain(): Promise<void> {
    const DEADLINE_MS = 60 * 1000; // one cycle spends at most a minute here
    const MAX_PASSES_PER_CLUB = 40; // 40 passes x 40 periods = 1,600 per club
    const started = Date.now();
    let settled = 0;
    let paid = 0;
    let deferred = 0;
    let errors = 0;
    const reasons: Record<string, number> = {};

    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: pendingClubs, error: readErr } = await supabase
        .from('rakeback_periods')
        .select('club_id')
        .eq('status', 'pending')
        .lt('period_end', today)
        .limit(5000);
      if (readErr) {
        reportError(
          new Error(`rakeback drain could not read pending clubs: ${readErr.message}`),
          'RakebackSettler.rakeback_drain_read'
        );
        return;
      }
      const clubIds = [...new Set((pendingClubs ?? []).map((r) => r.club_id).filter(Boolean))];

      for (const clubId of clubIds) {
        for (let pass = 0; pass < MAX_PASSES_PER_CLUB; pass++) {
          if (Date.now() - started > DEADLINE_MS) return;

          const { data, error } = await supabase.rpc('settle_club_rakeback', {
            p_club_id: clubId,
          });
          if (error) {
            errors++;
            reportError(
              new Error(`settle_club_rakeback failed for club ${clubId}: ${JSON.stringify(error)}`),
              'RakebackSettler.rakeback_drain'
            );
            break;
          }
          const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
          if (!r || r.success !== true) {
            errors++;
            reportError(
              new Error(`settle_club_rakeback refused for club ${clubId}: ${JSON.stringify(r)}`),
              'RakebackSettler.rakeback_drain_refused'
            );
            break;
          }

          const settledThisPass = Number(r.periods_settled ?? 0);
          settled += settledThisPass;
          paid += Number(r.total_payout ?? 0);
          deferred += Number(r.deferred ?? 0);
          errors += Number(r.errors ?? 0);
          for (const [k, v] of Object.entries(
            (r.deferred_reasons ?? {}) as Record<string, number>
          )) {
            reasons[k] = (reasons[k] ?? 0) + Number(v ?? 0);
          }

          // Drained, or this pass could move nothing. Either way stop asking:
          // the batch orders least-refused first, so a pass that settles zero
          // has already looked past everything it was going to skip.
          if (Number(r.periods_remaining ?? 0) === 0) break;
          if (settledThisPass === 0) break;
        }
      }
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.rakeback_drain_threw'
      );
    }

    if (settled > 0 || deferred > 0 || errors > 0) {
      console.log(
        `[RakebackSettler] Player rakeback: ${settled} periods paid, ${paid.toFixed(2)} chips, ` +
          `${deferred} deferred ${JSON.stringify(reasons)}, ${errors} errors`
      );
    }
  }

  private async runWeeklyFinancialClose(): Promise<void> {
    const WEEKLY_KEY = 'weekly_financial_close';
    try {
      const currentWeekStart = weekStart(new Date()); // Monday YYYY-MM-DD (UTC)
      const { data: state, error: stateErr } = await supabase
        .from('daemon_state')
        .select('high_water_mark')
        .eq('daemon', WEEKLY_KEY)
        .maybeSingle();
      if (stateErr) {
        console.warn('[RakebackSettler] weekly-close state read failed - will retry next cycle');
        return;
      }
      const lastClosedWeek = state?.high_water_mark
        ? new Date(state.high_water_mark).toISOString().slice(0, 10)
        : null;
      if (lastClosedWeek && lastClosedWeek >= currentWeekStart) return; // already closed this week

      console.log(
        `[RakebackSettler] Weekly financial close starting (week of ${currentWeekStart})`
      );

      // 1. Player rakeback payout MOVED OUT of this weekly gate on 2026-09-07,
      //    to runRakebackDrain(), which runs every cycle. settle_club_rakeback
      //    is bounded now (40 periods / ~4s per call), so it has to be called
      //    in a loop - and this method runs once per ISO week and stamps the
      //    week closed at step 4 whether or not anything drained. One bounded
      //    pass per club here would have paid 40 periods and latched for seven
      //    days. See the header of runRakebackDrain.

      // 2. Weekly agent credit invoices
      {
        const { data, error } = await supabase.rpc('fn_generate_all_credit_invoices', {
          p_period_end: `${currentWeekStart}T00:00:00Z`,
        });
        if (error || data?.success !== true || data?.failed !== 0) {
          reportError(
            new Error(
              error
                ? `fn_generate_all_credit_invoices failed: ${JSON.stringify(error)}`
                : 'fn_generate_all_credit_invoices did not confirm zero failed invoices'
            ),
            'RakebackSettler.weekly_invoices'
          );
          return;
        }
      }

      // 3. Reset weekly agent rake counters for the new week
      {
        const { error } = await supabase
          .from('agents')
          .update({ weekly_rake_generated: 0 })
          .gt('weekly_rake_generated', 0);
        if (error) {
          reportError(
            new Error(`weekly_rake_generated reset failed: ${error.message}`),
            'RakebackSettler.weekly_rake_reset'
          );
          return;
        }
      }

      // 4. Mark this week closed. Reset and latch are still separate writes;
      // a lost latch receipt must be reported, never logged as confirmed completion.
      const { error: closeError } = await supabase.from('daemon_state').upsert(
        {
          daemon: WEEKLY_KEY,
          high_water_mark: new Date(`${currentWeekStart}T00:00:00Z`).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'daemon' }
      );
      if (closeError) {
        reportError(
          new Error(`weekly-close latch failed: ${closeError.message}`),
          'RakebackSettler.weekly_close'
        );
        return;
      }
      console.log(
        '[RakebackSettler] Weekly financial close done: invoices generated, weekly counters reset'
      );
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.weekly_close'
      );
    }
  }

  private async _runSettlementInner(): Promise<CycleResult> {
    // On first run after (re)start, resume from the durable cursor so we do not
    // re-scan already-settled rake_records (which double-counts player_stats).
    // Only fall back to the 7-day window on a genuine first run.
    if (this.cursor === null) {
      const hwm = await this.loadHighWaterMark();
      if (!hwm.ok) {
        // RAKE-AUDIT 2026-07-24: watermark read failed — do NOT fall back to a
        // 7-day rescan (double-credits player_stats). Retry next interval.
        console.warn('[RakebackSettler] high-water-mark read failed - skipping cycle');
        return 'halted';
      }
      this.cursor = hwm.value;
    }

    // ════════════════════════════════════════════════════════════════════════
    // AUDIT M6 — composite (created_at, id) keyset read.
    //
    // The original filter was `.gt('created_at', since).limit(10000)` with the
    // new watermark taken from the LAST row's created_at. Two rows sharing one
    // created_at that straddle the LIMIT boundary are then lost forever: row
    // 10000 sets the watermark to T and row 10001 (also at T) is excluded by
    // the strict `>` on every subsequent cycle. Production has 12 such
    // duplicate-timestamp groups today, so the collision is real.
    //
    // The direction of the danger is asymmetric and decides the design: every
    // downstream accumulator is idempotent (credit_agent_commission_from_rake
    // dedupes on (user_id, source_id, source_type), apply_rakeback_player_stats
    // claims through rakeback_stats_applied, rakeback_periods recomputes from
    // source), so RE-processing a row costs nothing while SKIPPING one loses a
    // player's money with no trace. Everything below therefore prefers the
    // wider read whenever it is unsure.
    //
    // `.gt(created_at)` is still the fallback when the cursor has no id — the
    // first cycle after this deploy, when high_water_mark_id is still NULL.
    // That path is byte-for-byte the old behaviour, so the deploy is a no-op
    // until the first cycle writes an id, and exact from the second onward.
    // ════════════════════════════════════════════════════════════════════════
    const sinceIso =
      this.cursor?.createdAt ?? new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const useKeyset =
      this.cursor?.id != null &&
      isFilterSafe(this.cursor.createdAt) &&
      isFilterSafe(this.cursor.id);
    const startedAt = Date.now();

    // 1. Pull rake_records STRICTLY AFTER the last processed record (exclusive
    // cursor => exactly-once processing) that have player_contributions.
    // RAKE-AUDIT 2026-07-24: id + is_tournament added — tournament/SNG fee rows
    // have no hand_id (they are not hands), so agent-commission crediting keys
    // idempotency on rake_records.id for those rows instead of skipping them.
    const base = supabase
      .from('rake_records')
      .select(
        'id, is_tournament, tournament_id, hand_id, club_id, rake_amount, player_contributions, rake_method, created_at'
      );
    // ── 2026-08-17: the OR keyset predicate WAS the timeout ──
    //
    // `or=(created_at.gt."X",and(created_at.eq."X",id.gt."Y"))` is the textbook
    // composite keyset, and Postgres cannot use idx_rake_records_created_at_id
    // for it. It runs a full ordered index scan and applies the OR as a FILTER.
    // Measured against production:
    //
    //   OR keyset form   21,534 ms   Rows Removed by Filter: 560,302
    //   plain range         259 ms   same table, same LIMIT
    //
    // That is the [RakebackSettler.fetch_failed] "canceling statement due to
    // statement timeout" of 2026-08-17, and it explains why the failure looked
    // intermittent: the cold-start path (useKeyset false) already used the fast
    // form, so only cycles WITH a cursor died — the daemon that pays players
    // stalled precisely when it had made progress.
    //
    // Fix: ask for `created_at >= cursor` — sargable, index-friendly — then drop
    // the already-processed head of the page in memory (see the skip below).
    // Exactly-once is preserved: `gte` is a strict SUPERSET of the OR predicate
    // (it additionally returns the cursor row itself and any timestamp ties),
    // and the skip removes precisely that surplus. Ties on a timestamptz are
    // rare, so the overlap is a handful of rows per cycle.
    const filtered = useKeyset ? base.gte('created_at', sinceIso) : base.gt('created_at', sinceIso);
    const { data: rows, error: fetchErr } = await filtered
      .gt('rake_amount', 0)
      .not('player_contributions', 'is', null)
      // Both ORDER BY keys are required: the LIMIT boundary is only
      // deterministic if the sort is total, and a non-deterministic boundary
      // reintroduces the skip this fix exists to remove.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(FETCH_LIMIT);

    if (fetchErr) {
      reportError(
        new Error(fetchErr?.message || JSON.stringify(fetchErr) || String(fetchErr)),
        'RakebackSettler.fetch_failed'
      );
      return 'halted';
    }

    // Remove the surplus the `gte` widening introduced. On the keyset path the
    // page can begin with the cursor row itself plus any rows sharing its exact
    // timestamp that were already settled. Dropping them restores the old OR
    // predicate's semantics EXACTLY — strictly after (created_at, id) — without
    // asking Postgres for a filter it cannot index. Rows arrive ordered by
    // (created_at, id) ascending, so the already-seen entries are always a
    // contiguous prefix.
    // Page size AS POSTGRES RETURNED IT, captured before the skip below.
    //
    // `hitLimit` (further down) decides 'more' vs 'idle', i.e. whether the
    // drain loop goes round again. It must be judged on the RAW page: if the
    // skip removes even one row, a genuinely full 10,000-row page reads as
    // 9,999 and the settler concludes it is caught up while backlog remains.
    // The AUDIT M6 drain test caught exactly that.
    const rawPageSize = rows?.length ?? 0;

    if (useKeyset && rows && rows.length > 0) {
      const cursorId = this.cursor!.id as string;
      const before = rows.length;
      let drop = 0;
      while (drop < rows.length) {
        const r = rows[drop] as { created_at: string; id: string };
        if (r.created_at === sinceIso && r.id <= cursorId) drop++;
        else break;
      }
      if (drop > 0) {
        rows.splice(0, drop);
        console.log(
          `[RakebackSettler] keyset: skipped ${drop} already-settled row(s) at the cursor timestamp (page was ${before})`
        );
      }
    }

    if (!rows || rows.length === 0) {
      console.log(`[RakebackSettler] No new rake_records since ${sinceIso}`);
      // Nothing processed — leave the cursor untouched so any late-arriving
      // record with an earlier timestamp is still picked up next run.
      return 'idle';
    }

    // The exact position of the last row we will have fully processed this
    // batch. Persisting THIS (not now(), and not a Date-truncated copy of it)
    // guarantees no record after it is skipped and none before it is lost.
    const lastRow = rows[rows.length - 1] as RakeRecordRow;
    const nextCursor: RakeCursor = {
      createdAt: lastRow.created_at,
      id: lastRow.id ?? null,
    };
    // A full batch means there is almost certainly more behind it.
    // rawPageSize, not rows.length — see the note where it is captured. The
    // keyset skip can shorten `rows`, and judging fullness on the shortened
    // array would end the drain one page early and leave backlog unsettled.
    const hitLimit = rawPageSize >= FETCH_LIMIT;

    // A read failure or partial hand cannot become a newly calculated share.
    // Page the immutable attribution ledger before making any financial call.
    let ledger: Map<string, Map<string, number>>;
    try {
      const handIds = (rows as RakeRecordRow[])
        .map((r) => r.hand_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      ledger = await readRakeAttributionLedger(handIds, async (chunk, afterId) => {
        let query = supabase
          .from('rake_attributions')
          .select('id, hand_id, player_id, weighted_rake_credit')
          .in('hand_id', chunk)
          .order('id', { ascending: true })
          .limit(ATTRIBUTION_PAGE_SIZE);
        if (afterId !== null) query = query.gt('id', afterId);
        return await query;
      });
      assertCashAttributionComplete(rows as RakeRecordRow[], ledger);
    } catch (error) {
      reportError(error, 'RakebackSettler.ledger_incomplete_holds_cursor');
      return 'halted';
    }

    // 2. Aggregate per (user_id, club_id, week)
    type Bucket = {
      user_id: string;
      club_id: string;
      period_start: string;
      period_end: string;
      rake_generated: number;
    };
    const buckets = new Map<string, Bucket>();

    for (const row of rows as RakeRecordRow[]) {
      if (!row.player_contributions) continue;
      // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): method-aware, canonical
      // allocator. Weighted for new cash hands; historical DEALT_EQUAL rows
      // reproduce their historical equal split. Shares sum exactly to rake.
      const shares = sharesForRakeRecordWithLedger(row, ledger);
      if (shares.size === 0) continue;
      const created = new Date(row.created_at);
      const ws = weekStart(created);
      const we = weekEnd(created);

      for (const [userId, credit] of shares.entries()) {
        const key = `${userId}:${row.club_id}:${ws}`;
        const cur = buckets.get(key);
        if (cur) {
          cur.rake_generated = Math.round((cur.rake_generated + credit) * 100) / 100;
        } else {
          buckets.set(key, {
            user_id: userId,
            club_id: row.club_id,
            period_start: ws,
            period_end: we,
            rake_generated: credit,
          });
        }
      }
    }

    if (buckets.size === 0) {
      console.log(
        `[RakebackSettler] Processed ${rows.length} rake_records - no eligible player-credits`
      );
      this.cursor = nextCursor;
      await this.saveHighWaterMark(nextCursor);
      return hitLimit ? 'more' : 'idle';
    }

    // 2b. BUG 009 FIX — Agent commission credit (per-rake-record, not aggregated).
    // For each player credited above, look up their agent (if any) and credit the
    // commission via credit_agent_commission_from_rake RPC. The RPC handles the
    // commission_rate lookup, ROUND, audit insert, and accumulator updates atomically.
    let agentCreditsAttempted = 0;
    let agentCreditsFailed = 0;
    let agentCreditsSkippedNoHand = 0;
    let agentCreditsSkippedTournament = 0;
    const commissionItems: Record<string, unknown>[] = [];
    for (const row of rows as RakeRecordRow[]) {
      if (!row.player_contributions) continue;
      // Round 73: skip pre-R38-backfill rake_records that have no hand_id —
      // they can't be linked back to a hand for audit, and the settler used
      // to reprocess them on every restart (the cursor was in-memory only),
      // emitting NULL-source-id agent_commission rows on every cycle. Skipping
      // is correct: any commission for these legacy rows was already created
      // before the bug surfaced; reprocessing only creates duplicates.
      const handId = (row as { hand_id?: string | null }).hand_id;
      // TOURNAMENT RAKE IS ATTRIBUTED ONCE, AT SETTLEMENT (Phase 6, 2026-09-07).
      // fn_settle_tournament_rake -> fn_attribute_tournament_rake credits the
      // agent commission for every tournament rake row (entry fees, rebuys,
      // satellite seats, spin books) by metadata.user_id, keyed
      // md5('trs:' || tournament || user). The RAKE-AUDIT 2026-07-24 path here
      // predates that function and paid the same rake AGAIN for every
      // tournament row that carries player_contributions - spin books since
      // 2026-09-02: 6,753 spins settled on 2026-09-05 carrying 38,922.72 of
      // rake earned agents 23,263.81 here ('tournament_fee') and 26,742.03 at
      // settlement; 90,396.99 of 'tournament_fee' commission in the week of
      // 2026-08-31. Settlement is the one door; this loop is cash only.
      if (isTournamentRakeRow(row)) {
        agentCreditsSkippedTournament++;
        continue;
      }
      // Legacy NULL-hand CASH rows (pre-R38) are still skipped, as before:
      // they cannot be linked back to a hand for audit and were already paid.
      const sourceId = handId ?? null;
      const sourceType = 'rake_settlement';
      if (!sourceId) {
        agentCreditsSkippedNoHand++;
        continue;
      }
      // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): method-aware shares — the
      // commission basis is the player's credited rake under the hand's own
      // methodology. Shares sum exactly to the rake collected.
      const shares = sharesForRakeRecordWithLedger(row, ledger);
      if (shares.size === 0) continue;
      for (const [userId, credit] of shares.entries()) {
        agentCreditsAttempted++;
        commissionItems.push({
          user_id: userId,
          club_id: row.club_id,
          rake_credit: credit,
          source_type: sourceType,
          // Round 43: link the commission audit row + club_wallet_transactions
          // commission_out audit row back to the originating hand for
          // ledger reconciliation. For hands, sourceId is hand_history.id
          // (Round 38 FK); for tournament fees it is the rake_records.id.
          source_id: sourceId,
          notes: `RakebackSettler ${sourceType} at ${row.created_at}`,
        });
      }
    }

    // Ship the page's credits server-side in chunks. Identical semantics: the
    // batch function calls the SAME idempotent per-item function, and wraps
    // each element in its own exception block, so one bad element is isolated
    // exactly as a failed single call used to be.
    for (let i = 0; i < commissionItems.length; i += CREDIT_BATCH_SIZE) {
      const chunk = commissionItems.slice(i, i + CREDIT_BATCH_SIZE);
      try {
        const { data, error } = await supabase.rpc('fn_credit_agent_commissions_batch', {
          p_items: chunk,
        });
        if (error) {
          agentCreditsFailed += chunk.length;
          reportError(
            new Error(`fn_credit_agent_commissions_batch failed: ${error.message}`),
            'RakebackSettler.commission_batch'
          );
        } else {
          const r = readAttributionBatchReceipt(data, chunk.length, true);
          agentCreditsFailed += r.failed;
        }
      } catch (e) {
        agentCreditsFailed += chunk.length;
        reportError(
          new Error((e as { message?: string })?.message || String(e)),
          'RakebackSettler.commission_batch_threw'
        );
      }
    }
    if (
      agentCreditsAttempted > 0 ||
      agentCreditsSkippedNoHand > 0 ||
      agentCreditsSkippedTournament > 0
    ) {
      console.log(
        `[RakebackSettler] Agent-commission credits: ${agentCreditsAttempted - agentCreditsFailed}/${agentCreditsAttempted} OK` +
          (agentCreditsSkippedNoHand > 0
            ? `, ${agentCreditsSkippedNoHand} skipped (no hand_id - pre-R38 legacy rows)`
            : '') +
          (agentCreditsSkippedTournament > 0
            ? `, ${agentCreditsSkippedTournament} tournament rows left to settlement (fn_attribute_tournament_rake)`
            : '') +
          ' (RPC silently skips non-agent players)'
      );
    }

    // 2c. player_stats refresh — IDEMPOTENT per (rake_record, user).
    // RAKE-AUDIT 2026-07-24 [money-adjacent]: the old JS read-then-update
    // aggregate was NON-idempotent — a crash between the player_stats increment
    // and saveHighWaterMark() re-incremented every stat on the next cycle (the
    // watermark had not advanced). Now each (rake_record, user) is applied
    // exactly once via apply_rakeback_player_stats, which claims on
    // rakeback_stats_applied in the SAME transaction as the increment, so a
    // re-scan of already-processed rows can never double-count. (rakeback_periods
    // is recompute-from-source and agent commission dedupes, so this was the last
    // non-idempotent accumulator; the watermark no longer needs to be atomic
    // with the increment for correctness.)
    let psApplied = 0;
    let psFailures = 0;
    const statsItems: Record<string, unknown>[] = [];
    for (const row of rows as RakeRecordRow[]) {
      if (!row.player_contributions) continue;
      // Phase 6 (2026-09-07): tournament rake reaches player_stats once, at
      // settlement (fn_attribute_tournament_rake -> apply_rakeback_player_stats).
      if (isTournamentRakeRow(row)) continue;
      const rrId = (row as { id?: string }).id;
      if (!rrId) continue; // no durable id -> cannot key idempotency; skip (safe)
      // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): method-aware shares.
      const psShares = sharesForRakeRecordWithLedger(row, ledger);
      if (psShares.size === 0) continue;
      for (const [userId, credit] of psShares.entries()) {
        statsItems.push({
          rake_record_id: rrId,
          user_id: userId,
          club_id: row.club_id,
          hands: 1,
          rake: credit,
        });
      }
    }

    for (let i = 0; i < statsItems.length; i += CREDIT_BATCH_SIZE) {
      const chunk = statsItems.slice(i, i + CREDIT_BATCH_SIZE);
      try {
        const { data, error } = await supabase.rpc('fn_apply_rakeback_player_stats_batch', {
          p_items: chunk,
        });
        if (error) {
          psFailures += chunk.length;
          reportError(
            new Error(`fn_apply_rakeback_player_stats_batch failed: ${error.message}`),
            'RakebackSettler.player_stats_batch'
          );
        } else {
          const r = readAttributionBatchReceipt(data, chunk.length, false);
          psApplied += r.ok;
          psFailures += r.failed;
        }
      } catch (e) {
        psFailures += chunk.length;
        reportError(
          new Error((e as { message?: string })?.message || String(e)),
          'RakebackSettler.player_stats_batch_threw'
        );
      }
    }
    if (psApplied > 0 || psFailures > 0) {
      console.log(
        `[RakebackSettler] player_stats idempotent applies: ${psApplied} OK (failures: ${psFailures})`
      );
    }

    // Both operations commit independently and dedupe their own retries. A
    // failure must retain the source page: later period recomputation cannot
    // reconstruct a missing agent commission or player_stats application.
    if (agentCreditsFailed > 0 || psFailures > 0) {
      reportError(
        new Error(
          `[RakebackSettler] ${agentCreditsFailed} commission item(s) and ${psFailures} player stats item(s) failed; ` +
            `holding the watermark at ${this.cursor?.createdAt ?? 'start'} for an idempotent retry.`
        ),
        'RakebackSettler.attribution_failures_hold_cursor'
      );
      return 'halted';
    }

    // 3. Upsert into rakeback_periods. Round 45 RE-RUN fix: recompute the
    // FULL period total from the actual canonical rake_records rather than
    // INCREMENTING the existing row's rake_generated. The old incremental
    // logic double-counted on every engine restart because the settler's
    // 7-day fallback window re-processed already-credited records.
    //
    // Verified live before fix: top user had rake_generated=$4002 vs actual
    // share-from-rake_records of $1048 (4× over-credited from ~7 restarts).
    //
    // The new logic SETs rake_generated to the period total derived from
    // rake_records, so re-running over the same window converges to the
    // correct value rather than diverging.
    let upserts = 0;
    let failures = 0;
    {
      // ═══ AUDIT 2026-08-20 — this loop was the settler's dominant cost ═══
      //
      // It ran THREE round trips per (user, club, week) bucket, and the middle
      // one re-downloaded the club's ENTIRE week of rake_records — once per
      // user. Measured over 20 minutes of production traffic after the credit
      // batching landed: 164 batched credit calls versus ~3,000 round trips
      // from this block alone (1,094 rake_records GET + 1,084 rakeback_periods
      // GET + 582 POST + 256 PATCH).
      //
      // Now: each (club, week) window is fetched ONCE and every bucket in it is
      // computed from that single dataset, then all rows are persisted in one
      // call. The share arithmetic is the canonical method-aware allocator
      // (sharesForRakeRecord here, fn_allocate_rake_credits in SQL), so the
      // totals agree between the two by construction; only the transport
      // changed. (rake_generated decides the rakeback tier, so JS/SQL parity
      // is pinned by shared test vectors, not assumed.)
      const groups = new Map<
        string,
        { club_id: string; period_start: string; period_end: string }
      >();
      for (const b of buckets.values()) {
        groups.set(`${b.club_id}|${b.period_start}`, {
          club_id: b.club_id,
          period_start: b.period_start,
          period_end: b.period_end,
        });
      }

      // ═══ CRITICAL FIX 2026-08-20 — periods were computed from ~1% of a week ═══
      //
      // This block used to FETCH the club's week of rake_records and sum the
      // shares here. PostgREST caps a response at 1000 rows, so `.limit(50000)`
      // returned ~1000 rows of a week that actually holds 81,000-180,000:
      // rake_generated was derived from well under 1% of the data.
      //
      // Proven against live pending periods before the fix:
      //   user 1c1c12c2…   stored 23.17   actual 377.01   (16x understated)
      // and since rake_generated also selects the rakeback TIER (5/10/15/20/30%
      // at 100/500/2000/10000), that player sat in the 5% band instead of 10%,
      // compounding the shortfall on money owed to them.
      //
      // The row cap cannot be lifted from the client, so the computation moved
      // into the database, which has no such ceiling.
      // fn_rakeback_recompute_periods allocates per record with the canonical
      // fn_allocate_rake_credits — weighted for WEIGHTED_CONTRIBUTED rows,
      // the historical exact equal split for DEALT_EQUAL rows (jsonb sorts
      // equal-length UUID keys lexicographically, which matches the TS
      // tie-break) — then upserts while leaving paid weeks immutable. One call
      // per (club, week) instead of a truncated download.
      for (const g of groups.values()) {
        const userIds = [...buckets.values()]
          .filter((b) => b.club_id === g.club_id && b.period_start === g.period_start)
          .map((b) => b.user_id);
        if (userIds.length === 0) continue;
        try {
          const { data, error } = await supabase.rpc('fn_rakeback_recompute_periods', {
            p_club_id: g.club_id,
            p_period_start: g.period_start,
            p_period_end: g.period_end,
            p_user_ids: userIds,
          });
          if (error) {
            failures += userIds.length;
            reportError(
              new Error(
                `fn_rakeback_recompute_periods failed for ${g.club_id} ${g.period_start}: ${error.message}`
              ),
              'RakebackSettler.period_recompute'
            );
          } else {
            const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
            upserts += Number(r?.written ?? 0);
          }
        } catch (e) {
          failures += userIds.length;
          reportError(
            new Error((e as { message?: string })?.message || String(e)),
            'RakebackSettler.period_recompute_threw'
          );
        }
      }
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[RakebackSettler] Settled ${upserts}/${buckets.size} period rows from ${rows.length} hand records in ${elapsedMs}ms (failures: ${failures})`
    );

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A FAILED RECOMPUTE MUST NOT ADVANCE THE WATERMARK (2026-08-29)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `failures` was counted, logged, and then thrown away: the durable cursor
     * moved past those rake_records regardless, and the cycle returned
     * 'idle'/'more' rather than 'halted' -- even though this file defines
     * 'halted' as "a read failed: the cursor did NOT advance" and already uses
     * it for exactly that, twice.
     *
     * Why that is not self-healing. `fn_rakeback_recompute_periods` rebuilds a
     * (club, week) period FROM SOURCE, so a failure repairs itself only if
     * another rake record happens to land in the SAME club and the SAME ISO
     * week before that week closes. A failure on a week's last batch is
     * permanent, and it compounds: `rake_generated` is what selects the tier
     * band (5/10/15/20/30%), so a period computed from partial data can pay a
     * whole tier low. That is the failure mode the note above this method
     * records as having understated one player 16x and dropped them a tier.
     *
     * Not advancing means the next cycle re-reads the same window and tries
     * again, which is precisely what the two read-failure sites already do.
     * The work is idempotent -- recompute rebuilds from source and
     * player_stats applies are keyed -- so a retry costs a re-read, not a
     * double-credit.
     */
    if (failures > 0) {
      reportError(
        new Error(
          `[RakebackSettler] ${failures} period recompute(s) failed across ${buckets.size} bucket(s) - ` +
            `holding the watermark at ${this.cursor?.createdAt ?? 'start'} so the next cycle retries them. ` +
            `Advancing would leave those rake_records permanently unsettled, and rake_generated selects the ` +
            `rakeback tier, so a partial period can pay a whole band low.`
        ),
        'RakebackSettler.period_recompute_failures_hold_cursor'
      );
      return 'halted';
    }

    this.cursor = nextCursor;
    await this.saveHighWaterMark(nextCursor);
    return hitLimit ? 'more' : 'idle';
  }
}
