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
 * The worker submits each positive cash source to one database authority.
 * That authority uses immutable earning attribution and observed agreements,
 * records commissions and original player statistics atomically, and queues
 * the existing complete-week calculator. A refusal has a durable retry receipt
 * and blocks the affected book; it never becomes an acknowledged credit.
 * Tournament sources remain under their terminal recognition authority.
 *
 * RELATED:
 *   - Dan 2026-08-29: weighted contributed rake law (this file's split logic)
 *   - .memory/decisions/001-rake-equal-share.md (SUPERSEDED, kept as history)
 *   - .memory/problems/008-rakeback-settler-missing.md
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';
import { cashAccountingBatchSize, resolveClientTimeoutMs } from './cashAccountingBatchBudget.js';
import { isMaintenanceFrozen, onMaintenanceThaw } from '../maintenance/freezeState.js';
import { reportError } from './errorReporter.js';
import {
  readCashSourceBatchOutcome,
  verifyCashSourceRefusal,
  type CashSourceReceipt,
} from './cashSourceReceipts.js';
import { SETTLER_READ_HORIZON_RPC, readSettlerHorizon } from './rakebackReadHorizon.js';
import { pacificAccountingWeek } from './pacificAccountingWeek.js';

const SETTLEMENT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
/**
 * How soon to resume when a cycle ended with backlog still outstanding.
 * Deliberately short: the work is identical and already bounded per cycle by
 * MAX_DRAIN_BATCHES, so this only removes dead waiting.
 */
const CATCH_UP_DELAY_MS = 60 * 1000; // 1 minute
/**
 * How soon a halted page is tried again, given how many cycles in a row have
 * halted without acknowledging a page (2026-10-19). The first is retried on the
 * ordinary 60 s catch-up; each further one in a row doubles the wait, up to the
 * 30-minute interval and never past it. So one slow call costs a minute, not
 * half an hour, and a database that keeps failing is asked about once per
 * interval within six tries rather than in a loop.
 */
export function haltedPageRetryDelayMs(consecutiveStalls: number): number {
  if (!Number.isFinite(consecutiveStalls) || consecutiveStalls <= 1) return CATCH_UP_DELAY_MS;
  const doublings = Math.min(Math.floor(consecutiveStalls) - 1, 30);
  return Math.min(SETTLEMENT_INTERVAL_MS, CATCH_UP_DELAY_MS * 2 ** doublings);
}
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
 * past them. The functions now set their own 300s timeout.
 *
 * 2026-09-20: AND THEN THE SERVER STOPPED BEING THE CONSTRAINT, SO 150 WAS
 * SIZED AGAINST A LIMIT THAT NO LONGER BOUND IT. The 300s server timeout left
 * the engine client's DB_TIMEOUT_MS (15s) as the only real budget, and
 * migration 20260917181100 repointed fn_credit_agent_commissions_batch at
 * fn_process_cash_accounting_source, taking one item to ~290ms. 150 x 290ms =
 * 43.5s against a 15s client. The settler halted every cycle for three days
 * while the server committed the work anyway and the cursor never moved.
 * The size is now DERIVED from the budget that binds (CLAUDE.md 1.1.7); the
 * arithmetic and its measurement live in cashAccountingBatchBudget.ts.
 */
/* Exported for the same reason as FETCH_LIMIT: a regression suite must build
   a dataset that genuinely straddles this boundary, not hard-code a number
   that drifts away from the real one. A test asserting 150 was exactly how
   this constant stopped matching its own cost. */
export const CREDIT_BATCH_SIZE = cashAccountingBatchSize(resolveClientTimeoutMs());

/**
 * The durable-refusal retry opens every cycle, BEFORE any new work is read, so
 * it is the call that decides whether the cursor can move at all. It was a
 * literal 50 and cost ~20.6s - past the client budget - which is precisely how
 * a queue of 150 permanently-refused sources held 264,835 records hostage.
 * Same budget, same arithmetic, same reason.
 */
export const CASH_RETRY_LIMIT = cashAccountingBatchSize(resolveClientTimeoutMs());
/**
 * How long one inner run keeps retrying full batches of due refusals
 * (2026-10-19). CASH_RETRY_LIMIT bounds each CALL (its commission keys, its
 * time); this bounds how many calls one run makes, so the retry rate follows
 * the backlog instead of being fixed at one call a run. Measured on production
 * 2026-10-19 19:28-20:33: a retry call of 5 accrued sources spent about 0.2 s
 * in the database, so 30 s is on the order of a hundred calls, 500 sources, a
 * run; and a run still returns to the page within half a minute plus at most
 * one call's own 8 s budget.
 */
export const CASH_RETRY_DRAIN_BUDGET_MS = 30_000;
/**
 * A RETRY DRAIN THAT SETTLED NOTHING RESTS BEFORE IT IS ASKED AGAIN (2026-10-25).
 *
 * The drain above keeps calling while a call comes back full and "settled
 * something" - and a call that refuses every source again counted as settling
 * something, because a refusal is a receipt. Measured on production
 * 2026-10-24 23:21 - 2026-10-25 03:05 UTC: 61,354 sources were due with
 * accounting_terms_not_observed (55000, attempts 1-15), a refusal no retry can
 * clear until its evidence is repaired, and every inner run spent its whole
 * 30 s budget re-refusing them (5,600 retry receipts in that window, none
 * accrued) before it read a single fresh rake record.
 *
 * So the drain now continues only while a call ACCRUES at least one source,
 * and a drain that accrued nothing rests: no retry call at all for
 * retryRestMs(n) after the n-th such drain in a row - 1 minute, doubling, at
 * most the 30-minute interval. The first drain that accrues anything ends the
 * rest. Nothing about a refused source changes: its work row, its
 * next_attempt_at and its order in the queue belong to the database, which
 * still decides every retry; the engine only stops asking while asking has
 * been proved fruitless. A source refused by a lock (40P01/55P03/40001) is
 * retried by the database on its own short schedule whenever the engine next
 * asks, at most one rest later.
 */
export const CASH_RETRY_REST_BASE_MS = 60_000;
export const CASH_RETRY_REST_MAX_MS = 30 * 60 * 1000;
export function retryRestMs(consecutiveFruitlessDrains: number): number {
  if (!Number.isFinite(consecutiveFruitlessDrains) || consecutiveFruitlessDrains < 1) return 0;
  const doublings = Math.min(Math.floor(consecutiveFruitlessDrains) - 1, 30);
  return Math.min(CASH_RETRY_REST_MAX_MS, CASH_RETRY_REST_BASE_MS * 2 ** doublings);
}
const PERIOD_USER_BATCH_SIZE = 2000;
const DAEMON_KEY = 'rakeback_settler';

/**
 * Rows pulled from rake_records per batch. Exported so the M6 regression suite
 * can build a dataset that genuinely straddles the LIMIT boundary rather than
 * hard-coding a number that could drift away from the real one.
 */
export const FETCH_LIMIT = 1000;
// Responses may be capped below this requested size. A nonempty page always
// keeps the bounded drain active; only an empty indexed range proves catch-up.
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
/*
 * 2026-10-25: 3 -> 10. Three pages then a 60 s catch-up was sized when a page
 * took ~25 s; on 2026-10-24 a page of 1,000 took 300-400 s, so a cycle was
 * ~17 minutes of work then a minute idle, and every cycle also re-ran its
 * retry drain and horizon before the first page. Ten pages keeps one cycle
 * near an hour of work at the measured pace (bounded: a cycle still ends at
 * the cap, at a halt, at an empty range, and now when the maintenance freeze
 * begins), and the read-only sentinels still run as soon as backlog clears.
 */
export const MAX_DRAIN_BATCHES = 10;

/**
 * THE SETTLER CLEARS EACH HOST CLUB'S CASH IN ITS OWN LANE (2026-10-02).
 *
 * After #5864 cut a cash batch to 5 items so that a tournament finish never
 * waits long behind it for a club commission key, the settler ran one 5-item
 * call at a time. Read on production 21:40-21:50 UTC: one item costs about
 * 0.4 s, almost all of it reading cold index pages (the settler's backend was
 * in IO DataFileRead in 121 of 169 active samples, waiting on a key in 16), so
 * the settler accrued 105-110 sources a minute against 129-150 arriving, and
 * its cursor fell further behind every evening. fn_settler_lag_check calls a
 * lag over 6 hours unhealthy and fn_union_treasury_selftest then raises a
 * critical; a cursor still inside the closed week holds the weekly close.
 *
 * A longer batch would give back exactly what #5864 bought, so the batch stays
 * as it is. What changes is that the host clubs' batches stop queueing behind
 * one another. Cash rake on production comes from two host clubs, one per
 * union, and in the two hours read no record of one host attributed rake to a
 * club the other host's records touch: their commission keys are disjoint, so
 * a lane never waits for another lane. Where two hosts of one union do share a
 * key, the second batch waits for it as a finish already does, and the rare
 * deadlock is the refusal the source authority already records and retries
 * (40P01, 2,831 retried cleanly in the three days to 2026-10-02).
 *
 * Unchanged: the page, the batch size, item order within a club, every receipt
 * check, and the cursor, which is still saved only after every lane of the
 * page has finished.
 */
export const MAX_CASH_LANES = 4;

/**
 * A DEFERRED CASH SOURCE IS SUBMITTED AGAIN BEFORE THE CURSOR CAN PASS IT (2026-10-19).
 *
 * Migration 20261019094914 makes fn_credit_agent_commissions_batch take every club
 * commission key its items need, in club order, before the first item - a busy key
 * waited for at most 1 s while holding only lower keys - instead of letting an item
 * take its key out of order inside the rollup trigger, which deadlocked against
 * tournament finishes (40P01 2026-10-19 07:28:34; 31 first-attempt refusals that
 * morning). An item whose keys a finish still holds is DEFERRED: it writes nothing
 * and is named in the response. It is neither a refusal (no retry work exists for
 * it) nor an acknowledgement, so the lane submits exactly the deferred sources again,
 * up to CASH_DEFERRAL_RESUBMITS times, pausing CASH_DEFERRAL_PAUSE_MS between calls
 * (a finish holds a club's key for about 1-6 s). If a source is still deferred after
 * that, the page halts and the cursor stays where it is, exactly as for a failed call:
 * the next cycle starts from the same page and the database deduplicates what was
 * already accrued.
 *
 * Since 20261019190103 (2026-10-19) the database also defers the items a call has
 * no time left for: one call spends at most 8 s, so it always answers inside the
 * engine's 15 s client budget. Those deferrals come with progress - the call settled
 * what came before them - so CASH_DEFERRAL_RESUBMITS counts resubmissions IN A ROW
 * that settled nothing. A chunk behind slow row locks clears over several calls that
 * each make progress; only a run of calls that settle nothing holds the cursor.
 */
export const CASH_DEFERRAL_RESUBMITS = 3;
export const CASH_DEFERRAL_PAUSE_MS = 250;

/**
 * TWO WORKERS INSIDE ONE HOST CLUB'S LANE (2026-10-25).
 *
 * Since the Midway union took every cash game, production has ONE host club
 * (fade0000), so the per-host lanes above are one serial lane: measured
 * 2026-10-24 21:00-23:00 UTC it accrued ~7,000 first attempts an hour against
 * 13-15k cash hands arriving. A host club's chunks are now dealt, in page
 * order, round-robin to CASH_WORKERS_PER_LANE workers that run side by side.
 *
 * Why two workers cannot collide:
 *   - each chunk is a disjoint set of rake records, and a record is one hand
 *     (uq_rake_records_hand_id), so two workers never submit the same hand;
 *     if they ever did, fn_process_cash_accounting_source serializes on
 *     'accounting_cash_hand:<hand>' and the second returns the first's
 *     receipt (duplicate), writing nothing twice;
 *   - fn_credit_agent_commissions_batch takes every club commission key, then
 *     every player key, in one total order before its first item, waiting at
 *     most 1 s for a busy one while holding only lower keys, so two workers
 *     cannot deadlock each other; an item whose keys the other worker still
 *     holds is DEFERRED (writes nothing) and resubmitted exactly as one
 *     deferred behind a tournament finish (CASH_DEFERRAL_RESUBMITS);
 *   - a tournament finish waits behind at most one call as before: each call
 *     still fits COMMISSION_KEY_HOLD_MS, and the advisory-lock queue is FIFO;
 *   - the cursor is still saved only after every worker of every lane has
 *     stopped and every refusal has been read back.
 * Accounting is untouched: the same items, the same function, the same
 * receipts; only the order in which two disjoint chunks reach the database.
 */
export const CASH_WORKERS_PER_LANE = 2;

/** Deal a lane's chunks of `chunkSize`, in order, round-robin to `workers` workers. */
export function laneWorkers<T>(
  lane: T[],
  chunkSize: number,
  workers: number = CASH_WORKERS_PER_LANE
): T[][][] {
  const size = Math.max(1, Math.floor(chunkSize) || 1);
  const chunks: T[][] = [];
  for (let offset = 0; offset < lane.length; offset += size)
    chunks.push(lane.slice(offset, offset + size));
  const width = Math.max(1, Math.min(Math.floor(workers) || 1, chunks.length));
  const out: T[][][] = Array.from({ length: width }, () => []);
  chunks.forEach((chunk, n) => out[n % width].push(chunk));
  return out.filter((worker) => worker.length > 0);
}

/**
 * Split a page's cash rows into at most `maxLanes` lanes by host club. Rows of
 * one club stay together and in page order; clubs are dealt to lanes in the
 * order they first appear, so the split is deterministic for a given page.
 */
export function cashSourceLanes<T extends { club_id?: string | null }>(
  rows: T[],
  maxLanes: number = MAX_CASH_LANES
): T[][] {
  const byClub = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.club_id ?? '';
    const group = byClub.get(key);
    if (group) group.push(row);
    else byClub.set(key, [row]);
  }
  const width = Math.max(1, Math.min(Math.floor(maxLanes) || 1, byClub.size));
  const lanes: T[][] = Array.from({ length: width }, () => []);
  let n = 0;
  for (const group of byClub.values()) lanes[n++ % width].push(...group);
  return lanes.filter((lane) => lane.length > 0);
}

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
 *   'idle'   — an empty range proves there is no more visible source work
 *   'more'   — a nonempty page was durably acknowledged; check the next range
 *   'halted' — a read, source or checkpoint failed; retain the cursor and retry
 */
type CycleResult = 'idle' | 'more' | 'halted';

/** An immutable refusal without its durable retry work is not permission to
 * advance the source cursor. A later successful retry may supersede the receipt.
 *
 * ONE READ OF EACH TABLE PER CALL, NOT TWO ROUND TRIPS PER REFUSAL (2026-10-25).
 * Every refused receipt used to be read back with two sequential single-row
 * requests. Measured on production 2026-10-24 21:00-23:00 UTC: 10,355 such
 * reads at ~305 ms each, 3,168 s of the lane's ~5,250 busy seconds (60%), while
 * the batch RPCs themselves took 2,030 s - a third of each page went to
 * refusals (accounting_terms_not_observed), and every one of them cost the lane
 * ~0.6 s of round trips. The same two rows of every refusal are now read with
 * one `in` query per table, both at once, and each refusal is checked by the
 * same verifyCashSourceRefusal against exactly the rows it would have read
 * before: a row that is missing, foreign or different still refuses the page. */
export async function confirmCashSourceRefusals(receipts: CashSourceReceipt[]): Promise<void> {
  const refused = receipts.filter((receipt) => receipt.status === 'blocked');
  if (refused.length === 0) return;
  const [stored, work] = await Promise.all([
    supabase
      .from('accounting_cash_source_receipts')
      .select('id,rake_record_id,status,attempt,source_fingerprint,reason,result')
      .in(
        'id',
        refused.map((receipt) => receipt.receipt_id)
      ),
    supabase
      .from('accounting_cash_source_work')
      .select('rake_record_id,receipt_id,status,attempts')
      .in(
        'rake_record_id',
        refused.map((receipt) => receipt.rake_record_id)
      ),
  ]);
  if (stored.error)
    throw new Error('Cash source refusal receipt read failed', { cause: stored.error });
  if (work.error) throw new Error('Cash source retry work read failed', { cause: work.error });
  if (!Array.isArray(stored.data) || !Array.isArray(work.data))
    throw new Error('Cash source refusal readback missing');
  const receiptsById = new Map<unknown, unknown>(
    (stored.data as Array<{ id?: unknown }>).map((row) => [row?.id, row])
  );
  const workByRecord = new Map<unknown, unknown>(
    (work.data as Array<{ rake_record_id?: unknown }>).map((row) => [row?.rake_record_id, row])
  );
  for (const receipt of refused)
    verifyCashSourceRefusal(
      receipt,
      receiptsById.get(receipt.receipt_id),
      workByRecord.get(receipt.rake_record_id)
    );
}

/** A transport success does not prove that the period was written. */
interface PeriodRecomputeReceipt {
  written: number;
  deferred?: { requestId: string; requestedAt: string; reason: string };
}

function readPeriodRecomputeReceipt(
  data: unknown,
  submitted: number,
  expected: { club_id: string; period_start: string; period_end: string }
): PeriodRecomputeReceipt {
  const receipt = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    throw new Error('Missing period recompute receipt');
  const {
    written,
    error,
    failed,
    status,
    accounting_version,
    confirmed_players,
    club_id,
    period_start,
    period_end,
    request_id,
    requested_at,
    request_state,
    request_recorded,
    reason,
  } = receipt as Record<string, unknown>;
  if (
    typeof written !== 'number' ||
    !Number.isSafeInteger(written) ||
    written < 0 ||
    written > submitted ||
    (error !== undefined && error !== null) ||
    (failed !== undefined && failed !== 0) ||
    accounting_version !== 2 ||
    club_id !== expected.club_id ||
    period_start !== expected.period_start ||
    period_end !== expected.period_end
  )
    throw new Error('Invalid period recompute receipt');
  if (status === 'ready' && confirmed_players === submitted) return { written };
  if (
    status === 'blocked' &&
    written === 0 &&
    request_recorded === true &&
    request_state === 'blocked' &&
    typeof request_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request_id) &&
    typeof requested_at === 'string' &&
    Number.isFinite(new Date(requested_at).getTime()) &&
    typeof reason === 'string' &&
    reason.length > 0
  )
    return { written: 0, deferred: { requestId: request_id, requestedAt: requested_at, reason } };
  throw new Error('Invalid period recompute receipt');
}

async function confirmDeferredPeriodRequest(
  receipt: NonNullable<PeriodRecomputeReceipt['deferred']>,
  expected: { club_id: string; period_start: string; period_end: string }
): Promise<void> {
  const { data, error } = await supabase
    .from('accounting_period_recompute_requests')
    .select('id,status,last_result')
    .eq('id', receipt.requestId)
    .eq('club_id', expected.club_id)
    .eq('period_start', expected.period_start)
    .eq('period_end', expected.period_end)
    .eq('requested_at', receipt.requestedAt)
    .maybeSingle();
  if (
    error ||
    !data ||
    data.id !== receipt.requestId ||
    data.status !== 'blocked' ||
    data.last_result?.reason !== receipt.reason ||
    data.last_result?.status !== 'blocked' ||
    data.last_result?.accounting_version !== 2 ||
    data.last_result?.written !== 0
  )
    throw new Error('Deferred accounting request is not durably confirmed');
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TIMEOUT IS NOT A FAILURE: READ THE PERIOD'S DURABLE RECEIPT (2026-09-26)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The settler stopped advancing at 2026-09-22T10:37:05Z and stayed there. Every
 * cycle submitted the same page, called fn_rakeback_recompute_periods for club
 * 2a1132b9 week 2026-09-21 (46 players), and logged `supabase_timeout`. The
 * engine client gives up at DB_TIMEOUT_MS (15 s); the function sets its own
 * statement_timeout of 300 s and took ~71 s warm, ~127 s cold. So the SERVER
 * finished, wrote the periods and COMMITTED - accounting_period_recompute_requests
 * reached attempts=531 for that week - while the client counted every one of
 * those commits as a failure and held the watermark. Nothing could ever
 * converge: the retry repeats identical work against the identical budget.
 * With the mark frozen, fn_process_weekly_accounting_scope raises
 * weekly_rake_source_not_fully_accrued and the first weekly settlement fails.
 *
 * The hardening standard says it exactly: a timeout does not establish failure
 * or cancellation; read the durable outcome before retrying. The function
 * records its outcome in the same transaction as the period writes: it upserts
 * the (club, week) request row first, then sets attempted_at=clock_timestamp(),
 * attempts=attempts+1, last_result=<the receipt it returns> and
 * status='pending' for a user-scoped ready result ('complete' only for a
 * whole-period call, 'blocked' for a refusal). That row is visible if and only
 * if the transaction committed.
 *
 * So on an outcome the client could not observe, the settler reads that row
 * and accepts it only when ALL of these hold:
 *   * attempted_at is at or after the moment THIS call was sent - an earlier
 *     attempt's receipt is never mistaken for this one;
 *   * status is 'pending', the state this user-scoped call writes on success
 *     (a 'blocked' or 'complete' row was written by something else or refused);
 *   * last_result passes the same canonical receipt check a direct response
 *     must pass: accounting_version 2, this club and week, status 'ready' and
 *     confirmed_players equal to the players this call submitted.
 * Anything else - a failure receipt, a blocked request, a receipt that another
 * writer has since cleared, no receipt at all - is a failure exactly as before
 * and the watermark is held. A definite server error (a SQLSTATE or PostgREST
 * code) rolled back and is not read back at all.
 *
 * The wait is bounded by the server's own budget: the transaction either
 * commits or is cancelled by its 300 s statement_timeout, so after that plus a
 * short allowance for commit and transport there is nothing left to wait for.
 * It belongs to the original call (no timer, no sweep, no later repair) and a
 * stop() wakes it immediately so shutdown is never held behind it.
 *
 * DB_TIMEOUT_MS is deliberately NOT raised: the client budget protects every
 * other engine call, and a bigger number would only move the cliff.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CLOSED WEEK'S PAGE IS ITS CLOSE'S WORK (2026-10-12)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The settler held its watermark at 2026-10-12T06:51:48Z from 07:02 UTC on.
 * Its last page straddled the week boundary: 302 buckets of the week that
 * closed at 07:00 UTC (2026-10-12 00:00 America/Los_Angeles), for Club JAQK and
 * SHARK CLUB. Every page call of that closed week went to the calculator's
 * evidence path, whose checkpoint had been invalidated (the clubs scope digest
 * changes whenever any club is created), so each call re-read the whole week
 * from its first batch, ran into the function's 300 s statement_timeout and
 * rolled back. 140 failures a cycle, every cycle; the cursor never moved, and
 * the union weekly close refused the week because the settler had not reached
 * its end (settler_lag, weekly_rake_source_not_fully_accrued).
 *
 * A page recompute of a closed week can never be what certifies it. The close
 * (fn_prepare_accounting_week) recomputes EVERY club of its scope for the week
 * from source, and reuses only a whole-period receipt that is complete and
 * ready; a page call writes status 'pending', which it never reuses. So a page
 * of a closed week is redundant work the close does anyway. The settler now
 * leaves it to the close: it counts the group as deferred, sends nothing and
 * holds no lock, exactly as it already does for an open week that is known to
 * be refused. Sources, commissions and the cursor are unchanged.
 *
 * A week ends at 00:00 America/Los_Angeles on the day after period_end, the
 * same instant the database reads ((period_end + 1)::timestamp AT TIME ZONE
 * 'America/Los_Angeles'), read through pacificAccountingWeek, the helper that
 * names every credit's week. An unreadable period_end answers false: the page
 * is sent as before.
 */
export function periodWeekHasClosed(periodEnd: string, nowMs: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || !Number.isFinite(nowMs)) return false;
  // The week that holds "now" starts after period_end exactly when that week
  // has ended: both are Pacific calendar dates, so they compare as strings.
  return pacificAccountingWeek(new Date(nowMs)).periodStart > periodEnd;
}

export const PERIOD_RECOMPUTE_SERVER_BUDGET_MS = 300_000;
export const PERIOD_RECEIPT_READBACK_SLACK_MS = 15_000;
export const PERIOD_RECEIPT_READBACK_INTERVAL_MS = 5_000;

/** A SQLSTATE or PostgREST code means the server answered. Anything else - a
 * client deadline, a dropped socket, a thrown transport error - did not. */
export function periodRecomputeOutcomeIsUnknown(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const code = (error as { code?: unknown }).code;
  return !(typeof code === 'string' && /^(PGRST\d{3}|[0-9A-Z]{5})$/.test(code));
}

/** PostgREST renders timestamptz with microseconds; Date.parse needs ISO ms. */
function parseDbInstantMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const iso = value
    .trim()
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(iso);
}

export type PeriodReceiptVerdict =
  | { verdict: 'not_yet'; observation: string }
  | { verdict: 'confirmed'; written: number }
  | { verdict: 'deferred'; requestId: string; reason: string }
  | { verdict: 'refused'; reason: string };

const REQUEST_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A DURABLE DEFERRAL IS A DEFERRAL, HOWEVER LONG IT TOOK TO ARRIVE (2026-09-26).
 *
 * While the settler is catching up, every page-scoped recompute of the open
 * week is refused with cash_source_receipts_incomplete - the hands after this
 * page have no sources yet - and the function records that refusal on its
 * request row (status 'blocked', last_result = the receipt) in the same
 * transaction. A direct response carrying exactly that receipt has always been
 * accepted as a durable deferral (readPeriodRecomputeReceipt + the request row
 * read back): the page advances and the weekly close recomputes the whole
 * period later. The read-back refused the same receipt when the response was
 * lost, so a call slower than DB_TIMEOUT_MS could never advance the cursor.
 *
 * Measured on production 2026-09-26: the blocked path took 11.2 s idle and
 * 18.9-28.4 s under the 04:30 load against a 15 s client deadline, and the
 * cursor held at 2026-09-22 18:29:21 from 04:19 onward, every cycle logging
 * "durable receipt not confirmed: request is blocked".
 *
 * Accepted only when the row is fresh (the caller has already checked
 * attempted_at against this call), carries a request id, and its receipt is
 * the canonical deferral for exactly this club and week: version 2, status
 * blocked, nothing written, a named reason. Anything else is still refused.
 */
function durableDeferralReason(
  r: Record<string, unknown>,
  expected: { club_id: string; period_start: string; period_end: string }
): string | null {
  if (typeof r.id !== 'string' || !REQUEST_ID_SHAPE.test(r.id)) return null;
  const receipt = r.last_result;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const x = receipt as Record<string, unknown>;
  if (
    x.accounting_version !== 2 ||
    x.status !== 'blocked' ||
    x.written !== 0 ||
    x.club_id !== expected.club_id ||
    x.period_start !== expected.period_start ||
    x.period_end !== expected.period_end ||
    (x.error !== undefined && x.error !== null) ||
    (x.failed !== undefined && x.failed !== 0) ||
    typeof x.reason !== 'string' ||
    x.reason.length === 0
  )
    return null;
  return x.reason;
}

/**
 * Judge one read of the durable request row against the call that started at
 * `callStartedAtMs`. 'not_yet' means the row does not (yet) carry an attempt
 * made after this call was sent; the caller keeps reading until the server's
 * own deadline. 'refused' is final for this call.
 */
/**
 * How many of this club-week's attributions the database itself just reported
 * as lacking an accrued source, when that is the reason it refused. Null for
 * any other shape: only this exact refusal can seed the proof below.
 */
export function incompleteSourceCount(receipt: unknown): number | null {
  const r = Array.isArray(receipt) && receipt.length === 1 ? receipt[0] : receipt;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const x = r as Record<string, unknown>;
  if (
    x.status !== 'blocked' ||
    x.reason !== 'cash_source_receipts_incomplete' ||
    typeof x.source_count !== 'number' ||
    !Number.isSafeInteger(x.source_count) ||
    x.source_count < 1
  )
    return null;
  return x.source_count;
}

export function judgePeriodRecomputeReceipt(
  row: unknown,
  submitted: number,
  expected: { club_id: string; period_start: string; period_end: string },
  callStartedAtMs: number
): PeriodReceiptVerdict {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    return { verdict: 'not_yet', observation: 'no request row' };
  const r = row as Record<string, unknown>;
  if (
    r.club_id !== expected.club_id ||
    r.period_start !== expected.period_start ||
    r.period_end !== expected.period_end
  )
    return { verdict: 'refused', reason: 'request row names a different club or week' };
  const attemptedAtMs = parseDbInstantMs(r.attempted_at);
  if (!Number.isFinite(attemptedAtMs) || attemptedAtMs < callStartedAtMs)
    return {
      verdict: 'not_yet',
      observation: `latest attempt ${String(r.attempted_at)} predates this call`,
    };
  if (r.status === 'blocked') {
    const reason = durableDeferralReason(r, expected);
    return reason
      ? { verdict: 'deferred', requestId: String(r.id), reason }
      : {
          verdict: 'refused',
          reason:
            'request is blocked, and its receipt is not a canonical deferral for this club and week',
        };
  }
  if (r.status !== 'pending')
    return {
      verdict: 'refused',
      reason: `request is ${String(r.status)}, not a ready user-scoped receipt`,
    };
  try {
    const receipt = readPeriodRecomputeReceipt(r.last_result, submitted, expected);
    if (receipt.deferred) return { verdict: 'refused', reason: 'durable receipt is a deferral' };
    return { verdict: 'confirmed', written: receipt.written };
  } catch {
    return { verdict: 'refused', reason: 'durable receipt is not a ready receipt for this call' };
  }
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

interface RakeRecordRow {
  id?: string;
  is_tournament?: boolean | null;
  tournament_id?: string | null;
  hand_id: string | null;
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
   * A TICK THE FREEZE ATE IS STILL OWED (2026-09-21).
   *
   * The interval callback below must not settle during a maintenance freeze -
   * settlement credits commissions and rakeback, which is chip movement, and
   * the whole platform is meant to be still. That part was always right. What
   * was wrong is that it `return`ed and the tick was simply GONE.
   *
   * The freeze runs :53 to :00 and the interval is 30 minutes, so on a process
   * whose ticks land at :26 and :56 exactly half of them were inside the
   * freeze. Measured live 2026-09-21 on engine-01: settlement runs began at
   * 09:26, 10:26, 11:27, 12:27, 13:27 and 14:27 - once per hour, never at :56,
   * for a service configured to run every thirty minutes. At 15:26:06Z the
   * watermark was 2026-09-21T14:34:09Z, 52 minutes stale, with 985
   * rake_records above it; `fn_process_weekly_accounting_scope` raises
   * `weekly_rake_source_not_fully_accrued` and refuses to settle the week on
   * exactly that state.
   *
   * The drain has ample capacity - the 15:26 run cleared all 985 rows in under
   * a minute - so this was never a throughput problem. It was a lost tick.
   *
   * Remembering the debt and paying it on the thaw EVENT keeps both
   * guarantees: nothing moves during the freeze, and nothing is skipped
   * because of it. No timer, no poll, no repair loop - one boolean and one
   * edge-triggered callback.
   */
  private tickOwedFromFreeze = false;
  private thawUnsubscribe: (() => void) | null = null;
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
  /** Pending durable-receipt readbacks; stop() wakes them so shutdown never waits. */
  private readonly readbackWakers = new Set<() => void>();
  /**
   * A REFUSAL THE DATABASE HAS ALREADY PROVEN IS NOT ASKED AGAIN (2026-09-26).
   *
   * While the settler is behind, every page-scoped recompute of the open week
   * is refused with cash_source_receipts_incomplete: the hands after the page
   * have no accrued source yet. fn_calculate_cash_rakeback_periods reads the
   * whole week (every club's records, attributions, batches and sources) before
   * it says so. Measured live 2026-09-26 06:59-07:35Z: 20-222 s per call, up to
   * three club-weeks per page, so a page took 350-430 s and the drain fell to
   * ~7,000 records/hour while spending database CPU on answers already known.
   * The 60 s catch-up was re-arming every time; the pages were the cost.
   *
   * The refusal carries `source_count`: how many of this club's attributions in
   * the week lack a matching accrued source. That number can only fall through
   * an accrual, and the settler is the only writer that accrues a cash source
   * (fn_credit_agent_commissions_batch and fn_retry_cash_accounting_sources,
   * both called from this file; nothing else calls
   * fn_process_cash_accounting_source). Each accrued source returns one credit,
   * and one credit completes at most one attribution. So after the database
   * reports N, a later page that has accrued K credits for the same club-week
   * leaves at least N - K incomplete, and while that is >= 1 the call can only
   * be refused again. It is not sent; the page advances exactly as it does on
   * that refusal. New hands only add incomplete rows, which keeps the bound
   * safe. The first page after a start, any other outcome, or an exhausted
   * count sends the real call, so the page carrying a week's last record is
   * always recomputed, and fn_prepare_accounting_week recomputes every club's
   * whole period before any payer stage regardless.
   */
  private readonly openWeekIncomplete = new Map<string, number>();
  /**
   * Cycles in a row that halted without acknowledging a page. It sets how soon
   * the halted page is tried again (haltedPageRetryDelayMs); a cycle that
   * acknowledges a page, or finds nothing to do, sets it back to zero.
   */
  private consecutiveStalls = 0;
  /** Retry drains in a row that accrued nothing, and when the rest they earned ends. */
  private fruitlessRetryDrains = 0;
  private retryRestUntilMs = 0;

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
    /**
     * EVERY LAUNCH WAITS OUT THE FREEZE, NOT ONLY THE INTERVAL'S (2026-09-26).
     *
     * The interval tick already held itself for the thaw (2026-09-21, below).
     * The startup run and the 60 s catch-up did not. An engine restart lands
     * INSIDE the break by design (the new engine boots at ~:56 and adopts the
     * persisted break), so its startup run met the database freeze on its
     * first cash-source batch, halted with no page acknowledged, armed no
     * catch-up, and the settler sat idle until the next interval tick.
     * Measured 2026-09-26: restart 13:56:26 with 213 s of break left,
     * "Cash source batch failed" at 13:56:56, cursor still 2026-09-26
     * 13:52:12 at 14:03:53 while rake_records kept arriving - a full thirty
     * minutes lost to one boot. A catch-up armed at :54 lands in the freeze
     * the same way. The held run is recorded as the one tick the thaw owes and
     * paid there, exactly like the interval's.
     */
    if (isMaintenanceFrozen()) {
      if (!this.tickOwedFromFreeze) {
        this.tickOwedFromFreeze = true;
        console.log(
          `[RakebackSettler] maintenance freeze is on - holding ${context} and running it at the thaw`
        );
      }
      return;
    }
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
    // The thaw subscription comes first: a startup inside the break is held
    // by launchSettlement and must find the listener that will pay it.
    this.tickOwedFromFreeze = false;
    this.thawUnsubscribe = onMaintenanceThaw(() => this.payTickOwedFromFreeze(generation));
    // Run once immediately on startup (or at the thaw, when started inside the
    // break), then every 30 min
    this.launchSettlement(generation, 'RakebackSettler.startup_run');
    this.intervalHandle = setInterval(() => {
      // THE FREEZE (Dan 2026-09-01): settlement credits commissions and
      // rakeback - chip movement by definition. A 30-minute cadence loses
      // nothing to a 5-minute wait.
      //
      // ...but it loses a whole THIRTY-MINUTE cadence to a dropped tick. Wait,
      // do not skip: the debt is recorded here and paid on the thaw edge. See
      // `tickOwedFromFreeze`.
      if (isMaintenanceFrozen()) {
        if (!this.tickOwedFromFreeze) {
          this.tickOwedFromFreeze = true;
          console.log(
            '[RakebackSettler] maintenance freeze is on - holding this tick and running it at the thaw'
          );
        }
        return;
      }
      this.launchSettlement(generation, 'RakebackSettler.interval_run');
    }, SETTLEMENT_INTERVAL_MS);
  }

  /**
   * The freeze just lifted. Run the tick it swallowed, once, and only if this
   * generation still owns the schedule - `launchSettlement` re-checks that too,
   * and `runSettlement`'s own `isSettling` guard makes a collision with the
   * regular interval a no-op rather than a double credit.
   */
  private payTickOwedFromFreeze(generation: number): void {
    if (!this.tickOwedFromFreeze) return;
    this.tickOwedFromFreeze = false;
    if (!this.lifecycleIsCurrent(generation)) return;
    console.log('[RakebackSettler] maintenance freeze lifted - running the tick it held');
    this.launchSettlement(generation, 'RakebackSettler.freeze_deferred_run');
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
    // A live thaw listener holding a fenced generation is exactly the
    // post-stop admission race the lifecycle exists to close. Drop it, and
    // forget the debt: the next start() opens a new generation and its own
    // startup run already reads from the durable watermark.
    if (this.thawUnsubscribe) {
      this.thawUnsubscribe();
      this.thawUnsubscribe = null;
    }
    this.tickOwedFromFreeze = false;
    // A durable-receipt readback in progress gives up now (acceptingSettlements
    // is already false), holding its page for the next generation to replay.
    for (const wake of [...this.readbackWakers]) wake();

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
    }, haltedPageRetryDelayMs(this.consecutiveStalls));
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

  /** Advance memory only after the durable checkpoint accepts the same cursor. */
  private async saveHighWaterMark(cursor: RakeCursor): Promise<boolean> {
    try {
      const { error } = await supabase.from('daemon_state').upsert(
        {
          daemon: DAEMON_KEY,
          high_water_mark: cursor.createdAt,
          high_water_mark_id: cursor.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'daemon' }
      );
      if (error) throw error;
      this.cursor = cursor;
      return true;
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.saveHighWaterMark'
      );
      return false;
    }
  }

  /** Keep only a count the database itself reported for this exact refusal. */
  private rememberIncompleteWeek(weekKey: string, count: number | null): void {
    if (count === null) this.openWeekIncomplete.delete(weekKey);
    else this.openWeekIncomplete.set(weekKey, count);
  }

  private pauseReadback(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.readbackWakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.readbackWakers.add(wake);
    });
  }

  /**
   * Read the durable outcome of a period recompute whose response the client
   * never saw. See `judgePeriodRecomputeReceipt` for what counts; this only
   * owns the bounded wait for the server's own transaction to finish.
   */
  private async readBackPeriodRecompute(
    expected: { club_id: string; period_start: string; period_end: string },
    submitted: number,
    callStartedAtMs: number
  ): Promise<
    | {
        confirmed: true;
        written: number;
        deferred?: { requestId: string; reason: string; sourceCount: number | null };
      }
    | { confirmed: false; reason: string }
  > {
    const deadline =
      callStartedAtMs + PERIOD_RECOMPUTE_SERVER_BUDGET_MS + PERIOD_RECEIPT_READBACK_SLACK_MS;
    let observation = 'no read completed';
    for (;;) {
      if (!this.acceptingSettlements)
        return { confirmed: false, reason: `service stopping (${observation})` };
      try {
        const { data, error } = await supabase
          .from('accounting_period_recompute_requests')
          .select('id,club_id,period_start,period_end,status,attempted_at,attempts,last_result')
          .eq('club_id', expected.club_id)
          .eq('period_start', expected.period_start)
          .eq('period_end', expected.period_end)
          .maybeSingle();
        if (error) {
          observation = `request read failed: ${(error as { message?: string }).message ?? String(error)}`;
        } else {
          const verdict = judgePeriodRecomputeReceipt(data, submitted, expected, callStartedAtMs);
          if (verdict.verdict === 'confirmed') return { confirmed: true, written: verdict.written };
          if (verdict.verdict === 'deferred')
            return {
              confirmed: true,
              written: 0,
              deferred: {
                requestId: verdict.requestId,
                reason: verdict.reason,
                sourceCount: incompleteSourceCount(
                  (data as { last_result?: unknown } | null)?.last_result
                ),
              },
            };
          if (verdict.verdict === 'refused') return { confirmed: false, reason: verdict.reason };
          observation = verdict.observation;
        }
      } catch (e) {
        observation = `request read threw: ${(e as { message?: string })?.message ?? String(e)}`;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return {
          confirmed: false,
          reason: `no receipt from this call by the server's own deadline (${observation})`,
        };
      await this.pauseReadback(Math.min(PERIOD_RECEIPT_READBACK_INTERVAL_MS, remaining));
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
        let pagesAcknowledged = 0;
        for (let batch = 1; ; batch++) {
          const result = await this._runSettlementInner();
          if (result === 'more') pagesAcknowledged++;
          /*
           * PROGRESS FOLLOWED BY A HALT STILL LEAVES BACKLOG (2026-09-26).
           * The catch-up used to arm only when the drain cap was hit, so a
           * cycle that acknowledged pages and then halted on a later one slept
           * the full 30-minute interval with the halted page - and everything
           * behind it - still owed. That is the pacing that could not clear a
           * week's backlog before its close. Re-arm the same bounded catch-up
           * instead: one retry of the same page, and a cycle that halts on its
           * FIRST page (no progress) still waits the interval, so a persistent
           * failure never becomes a tight loop against the database.
           */
          /*
           * A HALTED PAGE COMES BACK ON THE NEXT SHORT TICK (2026-10-19).
           * A halt never means the work is done: the halted page, and
           * everything behind it, is still owed. Until today only a halt after
           * progress, or the one first-page halt right after a productive
           * cycle, re-armed the 60 s catch-up; any other first-page halt waited
           * the full 30-minute interval. Measured live 2026-10-19: one
           * fn_credit_agent_commissions_batch call ran 16.1 s at 17:02 (two
           * items waited 8 s each on a profiles row lock held by another
           * transaction), the client gave up at 15 s, the cycle had made no
           * progress before it, and the next settler activity was 17:29:59 -
           * cash accrual stood still for half an hour behind one slow call.
           * Every halt now re-arms the catch-up. A persistent failure still
           * never becomes a tight loop: halts with no acknowledged page in
           * between back off from 60 s, doubling, to the interval itself
           * (haltedPageRetryDelayMs), and the first acknowledged page resets it.
           */
          if (result === 'halted') {
            backlogRemains = true;
            if (pagesAcknowledged === 0) this.consecutiveStalls++;
            else this.consecutiveStalls = 0;
            console.warn(
              `[RakebackSettler] drain halted after ${pagesAcknowledged} acknowledged source page(s) - ` +
                `backlog remains; retrying the halted page in ` +
                `${haltedPageRetryDelayMs(this.consecutiveStalls) / 1000}s`
            );
            break;
          }
          if (result !== 'more') break;
          // The freeze refuses money writes: stop at a page boundary and let the
          // catch-up be held for the thaw (launchSettlement) rather than run a
          // page into the break and halt it.
          if (isMaintenanceFrozen() || !this.acceptingSettlements) {
            backlogRemains = true;
            break;
          }
          if (batch >= MAX_DRAIN_BATCHES) {
            backlogRemains = true;
            console.warn(
              `[RakebackSettler] drain cap reached after ${batch} source pages ` +
                `(up to ${batch * FETCH_LIMIT} records) - backlog may remain; resuming in ` +
                `${CATCH_UP_DELAY_MS / 1000}s instead of waiting the full interval`
            );
            break;
          }
        }
        if (pagesAcknowledged > 0 || !backlogRemains) this.consecutiveStalls = 0;
        this.scheduleCatchUp(backlogRemains, generation);
        // One server coordinator owns the schedule, financial stages, invoices,
        // notices and retries. Its receipt is the completion authority.
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
        /* THE OPEN WEEK HAS NO ECO TO PERSIST (2026-10-12). This cycle used to
           record the week in progress through fn_union_eco_record_current_week
           so an invoice could be reproduced later. Since 2026-09-17
           fn_union_eco_record first proves the union's P&L evidence with
           fn_require_union_pnl_evidence, which admits only a CLOSED week
           (start and end on week boundaries, end in the past), so every call
           here was refused with invalid_closed_pnl_evidence_period: three
           times an hour for twenty-five days, one
           RakebackSettler.eco_record_failed each, with nothing written. The
           closed week's ECO is written once, at close, by
           fn_union_settlement_cascade, which is also what the governance
           sentinel above checks (union_eco_not_recorded asks only about
           closed weeks). There is no open-week row left for this cycle to
           write, so it no longer asks. */
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
   * newest FULLY CHECKED ended_at so each tournament is checked at least once.
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
      let unchecked = 0;
      /**
       * A TOURNAMENT NOBODY COULD CHECK MUST NOT BE RECORDED AS CHECKED.
       *
       * Each of the three reads below was written `if (!err) { ... }`, so a
       * transient PostgREST failure skipped that tournament's integrity check with
       * no report and no violation counted - while the watermark, assigned at the
       * TOP of the loop, moved past it regardless. The next cycle reads
       * `ended_at > mark`, so the event was never looked at again: chips minted or
       * destroyed inside it would go unreported permanently and leave no trace,
       * which is the single outcome this sentinel exists to prevent. The two
       * top-level reads above already skip the cycle on a read failure; the
       * per-tournament reads were simply never given the same treatment.
       *
       * The batch is ordered by `ended_at` ascending, so from the first tournament
       * whose reads did not complete the mark may not move. Later tournaments are
       * still checked in this same pass - one unreadable row must not silence the
       * rest of the batch - they are simply re-read next cycle along with it.
       * Re-checking costs nothing: all three checks are read-only, and the pass
       * stays bounded by BATCH with no retry loop of its own.
       */
      let watermarkSealed = false;

      for (const t of tourneys as Array<{
        id: string;
        name: string | null;
        prize_pool: number | null;
        variant: string | null;
        satellite_target_id: string | null;
        ended_at: string;
      }>) {
        // Set by any of the three reads below that did not complete. The mark is
        // advanced at the END of this iteration, and only for a tournament whose
        // checks all actually ran.
        let uncheckable = false;
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
          if (pErr) {
            uncheckable = true;
            unchecked++;
            reportError(
              new Error(
                `Tournament payout conservation UNCHECKED: tournament ${t.id} ` +
                  `(${t.name ?? 'unnamed'}) prize read failed: ${pErr.message}`
              ),
              'TournamentSentinel.payout_conservation_unchecked',
              { tournamentId: t.id, endedAt: t.ended_at }
            );
          } else {
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
          if (sErr) {
            uncheckable = true;
            unchecked++;
            reportError(
              new Error(
                `Stranded-player check UNCHECKED: tournament ${t.id} ` +
                  `(${t.name ?? 'unnamed'}) entrant read failed: ${sErr.message}`
              ),
              'TournamentSentinel.stranded_players_unchecked',
              { tournamentId: t.id, endedAt: t.ended_at }
            );
          } else if ((count ?? 0) > 0) {
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
          if (rErr) {
            uncheckable = true;
            unchecked++;
            reportError(
              new Error(
                `Raked-hand check UNCHECKED: tournament ${t.id} ` +
                  `(${t.name ?? 'unnamed'}) rake read failed: ${rErr.message}`
              ),
              'TournamentSentinel.raked_tournament_hands_unchecked',
              { tournamentId: t.id, endedAt: t.ended_at }
            );
          } else if ((count ?? 0) > 0) {
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

        if (uncheckable) {
          if (!watermarkSealed) {
            watermarkSealed = true;
            // A tie on `ended_at` with an already-advanced mark would still be
            // stepped over by the strict `>` read filter next cycle, so fall back
            // to this batch's own starting mark, which that same filter proves is
            // strictly below every row in the batch.
            if (newWatermark >= t.ended_at) newWatermark = sinceIso;
          }
        } else if (!watermarkSealed && t.ended_at > newWatermark) {
          newWatermark = t.ended_at;
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
        `[TournamentSentinel] read ${tourneys.length} completed tournament(s), ${violations} violation(s), ` +
          `${unchecked} unchecked read(s), watermark → ${newWatermark}`
      );
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'TournamentSentinel.cycle'
      );
    }
  }

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

  private async runWeeklyFinancialClose(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_union_settlement_cascade_due', {});
      if (error) throw new Error(`Weekly accounting request failed: ${error.message}`);
      const result = Array.isArray(data) && data.length === 1 ? data[0] : data;
      if (!result || typeof result !== 'object' || result.success !== true) {
        throw new Error(`Weekly accounting remains incomplete: ${JSON.stringify(result)}`);
      }
      if (result.skipped === true) {
        if (!['maintenance_window', 'already_running'].includes(result.reason)) {
          throw new Error('Weekly accounting returned an unknown skip reason');
        }
        return;
      }
      if (
        result.failed !== 0 ||
        !Number.isSafeInteger(result.checked) ||
        result.checked < 0 ||
        !Array.isArray(result.detail) ||
        result.detail.length !== result.checked ||
        result.detail.some(
          (scope: { result?: { success?: boolean } }) => scope.result?.success !== true
        )
      ) {
        throw new Error(`Weekly accounting receipt is incomplete: ${JSON.stringify(result)}`);
      }
      if (result.checked > 0) {
        console.log(`[RakebackSettler] Weekly accounting confirmed ${result.checked} scope(s)`);
      }
    } catch (error) {
      reportError(error, 'RakebackSettler.weekly_close');
    }
  }

  /**
   * Retry due durable refusals for up to CASH_RETRY_DRAIN_BUDGET_MS, one small
   * call after another, while each call comes back full and settled something.
   *
   * Stops at the first call that is short (the due queue is drained), that
   * settled nothing (every source it chose was deferred for a busy key), when
   * the budget is spent, when the maintenance freeze begins, or when the
   * service is stopping. The first call failing throws, exactly as the single
   * call did (the run halts and backs off). A later call failing ends the
   * drain instead: every source an earlier call settled is already durable and
   * acknowledged here, and the failed call's sources stay in their queue.
   * `lastCallFull` says whether the queue may hold more (the #7439 backlog rule).
   */
  private async drainCashSourceRetries(): Promise<{
    receipts: CashSourceReceipt[];
    lastCallFull: boolean;
  }> {
    const receipts: CashSourceReceipt[] = [];
    // A drain that accrued nothing is resting (see CASH_RETRY_REST_BASE_MS).
    if (Date.now() < this.retryRestUntilMs) return { receipts, lastCallFull: false };
    const deadline = Date.now() + CASH_RETRY_DRAIN_BUDGET_MS;
    let deferredTotal = 0;
    let accruedTotal = 0;
    let lastCallFull = false;
    for (let call = 0; ; call++) {
      let retried: { receipts: CashSourceReceipt[]; deferred: string[] };
      try {
        const { data, error } = await supabase.rpc('fn_retry_cash_accounting_sources', {
          p_limit: CASH_RETRY_LIMIT,
        });
        if (error) throw new Error('Cash source retry failed', { cause: error });
        retried = readCashSourceBatchOutcome(data);
        if (retried.receipts.length + retried.deferred.length > CASH_RETRY_LIMIT)
          throw new Error('Cash retry exceeded its requested source bound');
        await confirmCashSourceRefusals(retried.receipts);
      } catch (error) {
        if (call === 0) throw error;
        reportError(error, 'RakebackSettler.source_retry_drain_ended');
        lastCallFull = true;
        break;
      }
      receipts.push(...retried.receipts);
      deferredTotal += retried.deferred.length;
      const accrued = retried.receipts.filter((r) => r.status === 'accrued').length;
      accruedTotal += accrued;
      lastCallFull = retried.receipts.length + retried.deferred.length === CASH_RETRY_LIMIT;
      // Only an accrual is progress: a call that refused every source again
      // proves the next call would too (A RETRY DRAIN THAT SETTLED NOTHING RESTS).
      if (!lastCallFull || accrued === 0) break;
      if (Date.now() >= deadline || isMaintenanceFrozen() || !this.acceptingSettlements) break;
    }
    if (receipts.length > 0 && accruedTotal === 0) {
      this.fruitlessRetryDrains++;
      const rest = retryRestMs(this.fruitlessRetryDrains);
      this.retryRestUntilMs = Date.now() + rest;
      console.log(
        `[RakebackSettler] ${receipts.length} retried cash source(s) refused again and none accrued; ` +
          `the retry queue rests ${rest / 1000}s (fruitless drain ${this.fruitlessRetryDrains} in a row)`
      );
      // A fruitless queue is not backlog this cursor can clear.
      lastCallFull = false;
    } else if (accruedTotal > 0 || receipts.length === 0) {
      this.fruitlessRetryDrains = 0;
      this.retryRestUntilMs = 0;
    }
    // A deferred retry keeps its blocked work row exactly as it was (no attempt is
    // spent) and is among the first due sources again; it is not this cursor's.
    if (deferredTotal > 0)
      console.log(
        `[RakebackSettler] ${deferredTotal} retried cash source(s) deferred: a commission key ` +
          `was busy or the call ran out of time; they stay first in the retry queue`
      );
    return { receipts, lastCallFull };
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

    // Retry durable refusals independently of the global cursor. The same
    // source authority restores commissions, original player stats and the
    // existing weekly recomputation queue before acknowledging a retry.
    //
    // THE RETRY DRAINS WHAT IS DUE, NOT FIVE A RUN (2026-10-19). One call of
    // CASH_RETRY_LIMIT per inner run retried 5 sources a run while 12,135
    // Midway sources sat due after their cause was fixed: 20 retries in 30
    // minutes, about 300 hours to drain. A run now keeps calling while each
    // call comes back full and made progress, for up to
    // CASH_RETRY_DRAIN_BUDGET_MS. Each call is still one small transaction of
    // CASH_RETRY_LIMIT sources inside the database's own 8 s call budget, so
    // every commission key is handed back between calls. See
    // drainCashSourceRetries().
    let retriedSources: CashSourceReceipt[];
    let retryBatchFull = false;
    try {
      const drained = await this.drainCashSourceRetries();
      retriedSources = drained.receipts;
      retryBatchFull = drained.lastCallFull;
    } catch (error) {
      reportError(error, 'RakebackSettler.source_retry_holds_cursor');
      return 'halted';
    }

    // THE SETTLER READS ONLY WHAT EVERY WRITER HAS COMMITTED (2026-09-27).
    // created_at is the writer's transaction START, so a row can commit after
    // later-stamped rows were read and the cursor moved past it; it was then
    // never reached (51 cash sources stranded 2026-09-26/27). Read only
    // below the instant every open transaction started after, asked BEFORE the
    // page so nothing below it can still be in flight when the page reads.
    let horizon: string;
    try {
      const { data, error } = await supabase.rpc(SETTLER_READ_HORIZON_RPC);
      if (error) throw new Error('Settler read horizon failed', { cause: error });
      horizon = readSettlerHorizon(data);
    } catch (error) {
      reportError(error, 'RakebackSettler.read_horizon_holds_cursor');
      return 'halted';
    }

    // Keep PostgreSQL microseconds unchanged. Complete the remaining timestamp
    // ties before moving to later timestamps: both queries are index ranges.
    // A widened >= page with a client-side prefix filter can fill entirely
    // with already-processed ties and permanently hide the remaining records.
    const sinceIso =
      this.cursor?.createdAt ?? new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const useKeyset =
      this.cursor?.id != null &&
      isFilterSafe(this.cursor.createdAt) &&
      isFilterSafe(this.cursor.id);
    const startedAt = Date.now();
    const sourceQuery = () =>
      supabase
        .from('rake_records')
        .select(
          'id, is_tournament, tournament_id, hand_id, club_id, rake_amount, player_contributions, rake_method, created_at'
        )
        .gt('rake_amount', 0)
        .lt('created_at', horizon)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(FETCH_LIMIT);
    let rows: RakeRecordRow[];
    try {
      let page;
      if (useKeyset) {
        page = await sourceQuery().eq('created_at', sinceIso).gt('id', this.cursor!.id!);
        if (page.error) throw page.error;
        if (!Array.isArray(page.data)) throw new Error('Cash source page missing');
        // A short response is not proof that all ties were returned: the server
        // may cap a page below FETCH_LIMIT. Only an empty tie page admits later times.
        if (page.data.length === 0) page = await sourceQuery().gt('created_at', sinceIso);
      } else {
        // A legacy timestamp without an ID may cover only part of that instant.
        // Replay it conservatively; the source authority already deduplicates it.
        page = await sourceQuery().gte('created_at', sinceIso);
      }
      if (page.error) throw page.error;
      if (!Array.isArray(page.data)) throw new Error('Cash source page missing');
      rows = page.data as RakeRecordRow[];
    } catch (error) {
      reportError(error, 'RakebackSettler.fetch_failed');
      return 'halted';
    }

    if ((!rows || rows.length === 0) && retriedSources.length === 0) {
      console.log(`[RakebackSettler] No new rake_records since ${sinceIso}`);
      // Nothing processed — leave the cursor untouched so any late-arriving
      // record with an earlier timestamp is still picked up next run.
      return 'idle';
    }

    // The exact position of the last row we will have fully processed this
    // batch. Persisting THIS (not now(), and not a Date-truncated copy of it)
    // guarantees no record after it is skipped and none before it is lost.
    const sourceRows = (rows ?? []) as RakeRecordRow[];
    const lastRow = sourceRows[sourceRows.length - 1];
    const nextCursor: RakeCursor | null = lastRow
      ? {
          createdAt: lastRow.created_at,
          id: lastRow.id ?? null,
        }
      : null;
    // Ask again after every nonempty page, including short responses. The
    // bounded drain/catch-up loop stops only after an actually empty range.
    //
    // THE RETRY QUEUE IS BACKLOG TOO (2026-10-19). A cycle whose page was empty
    // used to report 'idle' even when the retry had just returned a full batch,
    // so the settler slept its 30-minute interval with the refusal queue still
    // due: on 2026-10-19 ~700 due refusals were retried at 5 per inner run, two
    // runs per half hour, and Midway receipts refused once by a lock waited
    // behind them for most of a day. A full retry batch now keeps the same
    // bounded drain (MAX_DRAIN_BATCHES, then the 60 s catch-up) running.
    const backlogMayRemain = sourceRows.length > 0 || retryBatchFull;

    // Submit each positive cash record exactly once, even when its hand or
    // attribution is absent. The database alone decides whether its original
    // evidence can accrue or must remain a durable refusal. Tournament sources
    // remain under their existing terminal recognition authority.
    const sources = [...retriedSources];
    const cashRows = sourceRows.filter((row) => !isTournamentRakeRow(row));
    try {
      // ONE LANE PER HOST CLUB, RUN SIDE BY SIDE (2026-10-02). Each lane keeps
      // the same small batches in the same order; only lanes of different host
      // clubs overlap. See cashSourceLanes() for why that cannot add a wait.
      // A REFUSAL IS READ BACK BESIDE THE NEXT CALL, NOT BEFORE IT (2026-10-25).
      // Every refusal must be read back before the page is acknowledged, not
      // before the next chunk is submitted: the readback is read-only and the
      // cursor waits for all of them below. So it no longer sits on the lane's
      // critical path (60% of its time on 2026-10-24, see
      // confirmCashSourceRefusals).
      const confirmations: Promise<void>[] = [];
      const runWorker = async (chunks: RakeRecordRow[][]): Promise<void> => {
        for (const chunk of chunks) {
          const ids = chunk.map((row) => {
            if (!row.id) throw new Error('Cash source has no durable record identity');
            return row.id;
          });
          // Deferred sources are submitted again, in page order, before the page
          // can be acknowledged (see CASH_DEFERRAL_RESUBMITS).
          let pending = ids;
          // Resubmissions in a row that settled nothing. A call that settles
          // anything resets it: since 20261019190103 the database also defers
          // the items a call has no time left for, so a chunk behind slow row
          // locks clears over several calls that each make progress, and only
          // a run of calls that settle nothing holds the cursor.
          let fruitlessResubmissions = 0;
          for (let submission = 0; ; submission++) {
            const { data, error } = await supabase.rpc('fn_credit_agent_commissions_batch', {
              p_items: pending.map((id) => ({ source_type: 'cash_rake_record', source_id: id })),
            });
            if (error) throw new Error('Cash source batch failed', { cause: error });
            const { receipts, deferred } = readCashSourceBatchOutcome(data, pending);
            const confirmation = confirmCashSourceRefusals(receipts);
            // Observed now so an early rejection is never unhandled; awaited below.
            confirmation.catch(() => undefined);
            confirmations.push(confirmation);
            sources.push(...receipts);
            if (deferred.length === 0) break;
            fruitlessResubmissions =
              submission > 0 && receipts.length === 0 ? fruitlessResubmissions + 1 : 0;
            if (fruitlessResubmissions >= CASH_DEFERRAL_RESUBMITS)
              throw new Error(
                `${deferred.length} cash source(s) still deferred for a busy commission key after ` +
                  `${submission + 1} submissions; holding the cursor`
              );
            await new Promise((resolve) => setTimeout(resolve, CASH_DEFERRAL_PAUSE_MS));
            // The freeze guards refuse money writes; never resubmit into the break.
            if (isMaintenanceFrozen())
              throw new Error(
                'Maintenance freeze began while cash sources were deferred; holding the cursor'
              );
            pending = pending.filter((id) => deferred.includes(id));
          }
        }
      };
      // allSettled, then rethrow: the page is not acknowledged until every
      // worker of every lane has stopped, so none is still writing when the
      // cycle halts, and until every refusal it wrote has been read back.
      const workers = cashSourceLanes(cashRows).flatMap((lane) =>
        laneWorkers(lane, CREDIT_BATCH_SIZE)
      );
      const outcomes = await Promise.allSettled(workers.map(runWorker));
      const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
      if (failed) throw failed.reason;
      const confirmed = await Promise.allSettled(confirmations);
      const unconfirmed = confirmed.find(
        (o): o is PromiseRejectedResult => o.status === 'rejected'
      );
      if (unconfirmed) throw unconfirmed.reason;
    } catch (error) {
      reportError(error, 'RakebackSettler.attribution_failures_hold_cursor');
      return 'halted';
    }
    // The source transaction has already delegated the original idempotent
    // player-stats writer and queued each earning club's complete week. These
    // credits only select which existing period calculator to refresh now.
    type Bucket = {
      user_id: string;
      club_id: string;
      period_start: string;
      period_end: string;
    };
    const buckets = new Map<string, Bucket>();
    for (const source of sources) {
      for (const c of source.credits) {
        // One credit completes at most one incomplete attribution; counting
        // every credit, accrued or not, can only lower the bound.
        const weekKey = `${c.club_id}|${c.period_start}`;
        const known = this.openWeekIncomplete.get(weekKey);
        if (known !== undefined) this.openWeekIncomplete.set(weekKey, known - 1);
        buckets.set(`${c.player_id}:${c.club_id}:${c.period_start}`, {
          user_id: c.player_id,
          club_id: c.club_id,
          period_start: c.period_start,
          period_end: c.period_end,
        });
      }
    }
    const blockedSources = sources.filter((r) => r.status === 'blocked').length;
    if (blockedSources > 0) {
      console.warn(
        `[RakebackSettler] ${blockedSources} cash source(s) remain durably refused and scheduled for retry`
      );
    }
    if (buckets.size === 0) {
      if (nextCursor) {
        if (!(await this.saveHighWaterMark(nextCursor))) return 'halted';
      }
      return backlogMayRemain ? 'more' : 'idle';
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
    let deferredPeriods = 0;
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
      // (the database reads the original immutable attribution), so the
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
        const weekKey = `${g.club_id}|${g.period_start}`;
        // A CLOSED WEEK'S PAGE IS ITS CLOSE'S WORK (2026-10-12): see
        // periodWeekHasClosed. The close recomputes every club-week from source.
        if (periodWeekHasClosed(g.period_end, Date.now())) {
          deferredPeriods++;
          this.openWeekIncomplete.delete(weekKey);
          console.log(
            `[RakebackSettler] period recompute for ${g.club_id} ${g.period_start} not sent: the week ended ` +
              `${g.period_end} and its weekly close recomputes every club-week of it from source`
          );
          continue;
        }
        const stillIncomplete = this.openWeekIncomplete.get(weekKey);
        if (stillIncomplete !== undefined && stillIncomplete >= 1) {
          deferredPeriods++;
          console.log(
            `[RakebackSettler] period recompute for ${g.club_id} ${g.period_start} not sent: the database ` +
              `reported this week's sources incomplete and at least ${stillIncomplete} still are, so it ` +
              `could only be refused; the week stays queued`
          );
          continue;
        }
        this.openWeekIncomplete.delete(weekKey);
        const groupUserIds = [...buckets.values()]
          .filter((b) => b.club_id === g.club_id && b.period_start === g.period_start)
          .map((b) => b.user_id);
        for (let offset = 0; offset < groupUserIds.length; offset += PERIOD_USER_BATCH_SIZE) {
          const userIds = groupUserIds.slice(offset, offset + PERIOD_USER_BATCH_SIZE);
          // Sent-at on this clock: a durable receipt older than this belongs
          // to an earlier attempt and can never stand in for this call.
          const callStartedAtMs = Date.now();
          try {
            let response: { data: unknown; error: unknown };
            try {
              response = await supabase.rpc('fn_rakeback_recompute_periods', {
                p_club_id: g.club_id,
                p_period_start: g.period_start,
                p_period_end: g.period_end,
                p_user_ids: userIds,
              });
            } catch (thrown) {
              response = { data: null, error: thrown ?? new Error('period recompute threw') };
            }
            const { data, error } = response;
            if (error) {
              const message = (error as { message?: string })?.message ?? String(error);
              // Only an outcome the client could not observe is read back; a
              // definite server error rolled its transaction back.
              const readback = periodRecomputeOutcomeIsUnknown(error)
                ? await this.readBackPeriodRecompute(g, userIds.length, callStartedAtMs)
                : null;
              if (readback?.confirmed && readback.deferred) {
                // The same durable deferral a direct response would have
                // carried; the weekly close recomputes the whole period.
                deferredPeriods++;
                this.rememberIncompleteWeek(weekKey, readback.deferred.sourceCount);
                console.log(
                  `[RakebackSettler] fn_rakeback_recompute_periods for ${g.club_id} ${g.period_start}: ` +
                    `client saw "${message}" after ${Date.now() - callStartedAtMs}ms; this call's durable ` +
                    `request ${readback.deferred.requestId} records a deferral (${readback.deferred.reason}) - accepted`
                );
              } else if (readback?.confirmed) {
                upserts += readback.written;
                console.log(
                  `[RakebackSettler] fn_rakeback_recompute_periods for ${g.club_id} ${g.period_start}: ` +
                    `client saw "${message}" after ${Date.now() - callStartedAtMs}ms; the durable receipt ` +
                    `confirms ${userIds.length} player(s) committed by this call - accepted`
                );
              } else {
                failures += userIds.length;
                reportError(
                  new Error(
                    `fn_rakeback_recompute_periods failed for ${g.club_id} ${g.period_start}: ${message}` +
                      (readback ? `; durable receipt not confirmed: ${readback.reason}` : '')
                  ),
                  'RakebackSettler.period_recompute'
                );
              }
            } else {
              const receipt = readPeriodRecomputeReceipt(data, userIds.length, g);
              if (receipt.deferred) {
                await confirmDeferredPeriodRequest(receipt.deferred, g);
                deferredPeriods++;
                this.rememberIncompleteWeek(weekKey, incompleteSourceCount(data));
              } else {
                upserts += receipt.written;
              }
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
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[RakebackSettler] Acknowledged ${sources.length - blockedSources} source records; confirmed ${upserts}/${buckets.size} period rows, ${deferredPeriods} durable deferred periods in ${elapsedMs}ms (failures: ${failures})`
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

    if (nextCursor) {
      if (!(await this.saveHighWaterMark(nextCursor))) return 'halted';
    }
    return backlogMayRemain ? 'more' : 'idle';
  }
}
