/**
 * Work-triggered hand projection worker.
 *
 * The accepted-hand RPC commits money, history, tournament chip state and one
 * durable outbox row.  Dashboard/stat/mission projections are intentionally
 * outside that locking path.  This worker is woken by the committing engine,
 * by LISTEN hand_projection_outbox (./handOutboxListener.ts), by Realtime
 * until the 2026-09-10 cutover completes, once at process start, and by a 5 s
 * safety poll that fires only while no drain is running and no causal retry is
 * armed. A failed or dependency-deferred claim owns one bounded exponential
 * retry chain until it commits; that chain is caused by the unresolved durable
 * row and is fenced and joined by the worker lifecycle. Every wake is counted
 * by source in poker_hand_projection_wakes_total so the Realtime -> LISTEN
 * cutover can be measured before the table leaves the publication.
 *
 * THROUGHPUT (2026-09-10). One drain reads the outbox in global hand_number
 * order and projects it as one chain PER TABLE, up to
 * HAND_PROJECTION_DRAIN_CONCURRENCY (default 4) chains at a time. Order
 * inside a table is strict: a chain stops at its first failed or deferred
 * hand and every later hand of that table in the pass is deferred without a
 * round-trip, because the database refuses to leapfrog an earlier outbox row
 * (predecessor_pending) anyway. Across tables the database already
 * serialises with two per-table advisory locks (hand-post-commit:<table>,
 * hand-projection:<table>) and shards the club day counter by backend pid,
 * so N tables in parallel is the concurrency it was built for. Measured
 * before this change: one serial PostgREST call per hand at ~195 ms wall was
 * ~300 hands/min against ~600/min arriving, and the outbox reached 100k rows.
 */

import { AsyncResource } from 'node:async_hooks';
import { currentTournamentDataAuthority } from './dataActorContext.js';
import { supabase } from './client.js';
import { reportError, describeError } from '../errorReporter.js';

type ProjectionRow = {
  hand_id: string;
  table_id?: string | null;
  hand_number: number;
};

type ProjectionResult = {
  ok?: boolean;
  reason?: string;
  hand_id?: string;
};

export type HandProjectionDrainSummary = {
  projected: number;
  alreadyCompleted: number;
  deferred: number;
  failed: number;
};

export type HandPostCommitResult = {
  ok?: boolean;
  reason?: string;
  already_completed?: boolean;
  hand_id?: string;
  hand_number?: number;
  pending_addons?: number;
};

/**
 * Consume the immutable work envelope attached to an accepted hand.
 *
 * This call deliberately carries no dealer lease: once the exact settlement
 * transaction commits, completing its frozen obligations is authorized by the
 * durable hand receipt, not by whichever process happens to resume it. The
 * database row lock and completed receipt make concurrent live/worker calls
 * converge exactly once.
 */
export async function processHandPostCommitObligations(
  handId: string
): Promise<HandPostCommitResult> {
  const apply = async (id: string): Promise<HandPostCommitResult> => {
    const { data, error } = await supabase.rpc('fn_ca_process_hand_post_commit_obligations', {
      p_hand_id: id,
    });
    // A PostgrestError is a plain object, not an Error. Rethrowing it as-is
    // made every caller that serialised it with String(err) record
    // "[object Object]" - see describeError. Carry the detail in a real Error
    // so the type the callers are annotated for is the type they receive.
    if (error) throw new Error(`post-commit obligations RPC failed: ${describeError(error)}`);
    return (data ?? {}) as HandPostCommitResult;
  };
  const initial = await apply(handId);
  if (initial.ok === true || initial.reason !== 'predecessor_pending') return initial;

  // A recovered table can have an older accepted hand whose dealer vanished.
  // Retrying only this hand cannot advance that dependency. Waiting for the
  // global statistics outbox instead stranded live tables for minutes.
  // Help ONLY this table's earlier immutable envelopes, oldest first, through
  // the same row-locked, receipt-protected function. Never mark work complete
  // locally and never run dashboard projections on the dealing path.
  const { data: target, error: targetError } = await supabase
    .from('hand_atomic_commits')
    .select('table_id,hand_number')
    .eq('hand_id', handId)
    .maybeSingle();
  if (targetError)
    throw new Error(`post-commit predecessor lookup failed: ${describeError(targetError)}`);
  if (!target) return initial;
  const { data: earlier, error: earlierError } = await supabase
    .from('hand_atomic_commits')
    .select('hand_id')
    .eq('table_id', target.table_id)
    .lt('hand_number', target.hand_number)
    .not('post_commit_payload', 'is', null)
    .is('post_commit_completed_at', null)
    .order('hand_number', { ascending: true })
    .limit(16);
  if (earlierError)
    throw new Error(`post-commit predecessor scan failed: ${describeError(earlierError)}`);
  for (const predecessor of earlier ?? []) {
    const result = await apply(predecessor.hand_id);
    // The oldest unresolved dependency still owns the barrier on any doubt.
    // Return the requested hand's refusal, not another hand's success receipt.
    if (result.ok !== true) return initial;
  }
  // Includes the concurrent-worker case (the read found no earlier work).
  // Only the requested hand's authoritative receipt can unblock its engine.
  return apply(handId);
}

const DRAIN_PAGE = 100;
const DRAIN_MAX = 1_000;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 15_000;

/**
 * An env var read with a default that keeps the worker safe when the value
 * is absent, empty, or nonsense: "" (a copied .env.example line) would
 * otherwise become Number("") === 0 and a 0 ms setInterval.
 */
function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/* Safety net for a lost wake (dropped LISTEN socket, Realtime channel in
 * CHANNEL_ERROR, worker restarted between commit and wake). One `limit 100`
 * read every 5 s when the outbox is empty is ~3 ms of database time; it is
 * skipped while a drain is already running or a causal retry is armed, so it
 * never resets the retry backoff and never queues a redundant continuation
 * pass. It is a net under the event paths, not a replacement. Since the
 * 2026-09-10 cutover it is also the ONLY cross-process wake on the engine
 * host (no LISTEN credential there; Realtime left the publication), which is
 * why it is bounded below at 250 ms and why pollIsDue never lets an armed
 * retry hold it off for longer than RETRY_MAX_MS plus two intervals. */
export const HAND_PROJECTION_POLL_MS = boundedEnvInt('HAND_PROJECTION_POLL_MS', 5_000, 250, 60_000);
export const HAND_PROJECTION_DRAIN_CONCURRENCY_DEFAULT = 4;
export const HAND_PROJECTION_DRAIN_CONCURRENCY_MAX = 16;

/**
 * Chains projected at once. Read per drain so an operator change and a spec
 * take effect without a restart of the module.
 */
export function handProjectionDrainConcurrency(): number {
  return boundedEnvInt(
    'HAND_PROJECTION_DRAIN_CONCURRENCY',
    HAND_PROJECTION_DRAIN_CONCURRENCY_DEFAULT,
    1,
    HAND_PROJECTION_DRAIN_CONCURRENCY_MAX
  );
}

/**
 * Whether the safety poll should wake the worker now. Pure so the starvation
 * rule is testable on its own: a running drain always wins; an armed causal
 * retry wins only while it is plausibly about to fire. If no drain has
 * STARTED for RETRY_MAX_MS plus two poll intervals, the retry is not doing
 * its job (a lost timer, a fenced epoch) and the poll drains regardless.
 */
export function pollIsDue(state: {
  drainRunning: boolean;
  retryArmed: boolean;
  msSinceLastDrainStart: number;
  pollMs: number;
}): boolean {
  if (state.drainRunning) return false;
  if (!state.retryArmed) return true;
  return state.msSinceLastDrainStart > RETRY_MAX_MS + 2 * state.pollMs;
}

export type HandProjectionWakeSource =
  | 'local' // handHistory.ts after the settlement RPC commits
  | 'realtime' // postgres_changes callback (removed at cutover step 2)
  | 'listen' // NOTIFY hand_projection_outbox via handOutboxListener.ts
  | 'listen_resync' // one drain after every LISTEN (re)connect
  | 'poll' // the 5 s safety timer
  | 'startup'; // startHandProjectionWorker

const wakeCounts: Record<HandProjectionWakeSource, number> = {
  local: 0,
  realtime: 0,
  listen: 0,
  listen_resync: 0,
  poll: 0,
  startup: 0,
};

/** Read-only view for /metrics and specs. */
export function handProjectionWakeCounts(): Readonly<Record<HandProjectionWakeSource, number>> {
  return { ...wakeCounts };
}

export type HandProjectionDrainResult = 'projected' | 'already_completed' | 'deferred' | 'failed';

const drainResultCounts: Record<HandProjectionDrainResult, number> = {
  projected: 0,
  already_completed: 0,
  deferred: 0,
  failed: 0,
};
let drainsTotal = 0;
let lastDrainStartedAt = 0;

/** Read-only view for /metrics and specs. */
export function handProjectionDrainResultCounts(): Readonly<
  Record<HandProjectionDrainResult, number>
> {
  return { ...drainResultCounts };
}

export function handProjectionWakesToPrometheus(): string[] {
  const out = [
    '# HELP poker_hand_projection_wakes_total Wake signals delivered to the hand projection worker, by source.',
    '# TYPE poker_hand_projection_wakes_total counter',
  ];
  for (const [source, n] of Object.entries(wakeCounts)) {
    out.push(`poker_hand_projection_wakes_total{source="${source}"} ${n}`);
  }
  out.push(
    '# HELP poker_hand_projection_drain_results_total Outbox rows handled by the projection drain, by outcome. rate(result="projected") is the drain throughput.',
    '# TYPE poker_hand_projection_drain_results_total counter'
  );
  for (const [result, n] of Object.entries(drainResultCounts)) {
    out.push(`poker_hand_projection_drain_results_total{result="${result}"} ${n}`);
  }
  out.push(
    '# HELP poker_hand_projection_drains_total Drain passes started since process start.',
    '# TYPE poker_hand_projection_drains_total counter',
    `poker_hand_projection_drains_total ${drainsTotal}`,
    /* HOW LONG THE CURRENT PASS HAS BEEN RUNNING, zero when none is. A pass
       that never settles used to take the safety poll out of service with no
       series anywhere saying so: `drains_total` simply stopped moving, which
       reads identically to a quiet outbox. It is bounded now
       (DRAIN_DEADLINE_MS), and this is the number that shows a pass
       approaching that bound before it is hit. */
    '# HELP poker_hand_projection_drain_age_ms Age of the drain pass in flight, zero when none is.',
    '# TYPE poker_hand_projection_drain_age_ms gauge',
    `poker_hand_projection_drain_age_ms ${drainPromise === null ? 0 : Math.max(0, Date.now() - lastDrainStartedAt)}`,
    '# HELP poker_hand_projection_drain_concurrency Per-table chains the drain projects at once (HAND_PROJECTION_DRAIN_CONCURRENCY).',
    '# TYPE poker_hand_projection_drain_concurrency gauge',
    `poker_hand_projection_drain_concurrency ${handProjectionDrainConcurrency()}`,
    '# HELP poker_hand_projection_poll_interval_seconds Safety poll interval (HAND_PROJECTION_POLL_MS).',
    '# TYPE poker_hand_projection_poll_interval_seconds gauge',
    `poker_hand_projection_poll_interval_seconds ${HAND_PROJECTION_POLL_MS / 1000}`
  );
  return out;
}

let channel: ReturnType<typeof supabase.channel> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let drainPromise: Promise<HandProjectionDrainSummary> | null = null;
let wakeAfterDrain = false;
let stopping = false;
let workerActive = false;
let runOwnedDrain: (() => Promise<HandProjectionDrainSummary>) | null = null;
let lifecycleEpoch = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function emptySummary(): HandProjectionDrainSummary {
  return { projected: 0, alreadyCompleted: 0, deferred: 0, failed: 0 };
}

/**
 * Project one table's rows, oldest first, stopping at the first row the
 * database did not consume. Every later row of that table in this pass is
 * deferred without a round-trip: its predecessor is still in the outbox, so
 * fn_project_hand_side_effects would answer predecessor_pending. A row
 * another process already finished (not_pending) does not stop the chain.
 */
async function projectChain(
  chain: ProjectionRow[],
  blockedTables: Set<string>,
  summary: HandProjectionDrainSummary
): Promise<void> {
  const key = chainKey(chain[0]);
  for (let i = 0; i < chain.length; i++) {
    if (stopping) return;
    const row = chain[i];
    if (blockedTables.has(key)) {
      const remaining = chain.length - i;
      summary.deferred += remaining;
      drainResultCounts.deferred += remaining;
      return;
    }
    try {
      const { data: projected, error: projectError } = await supabase.rpc(
        'fn_project_hand_side_effects',
        { p_hand_id: row.hand_id }
      );
      if (projectError)
        throw new Error(`fn_project_hand_side_effects failed: ${describeError(projectError)}`);
      const result = (projected ?? {}) as ProjectionResult;
      if (result.ok === true) {
        summary.projected++;
        drainResultCounts.projected++;
      } else if (result.reason === 'not_pending') {
        // Another engine process owned the same durable row and committed
        // before this RPC acquired it.  No projection was skipped.
        summary.alreadyCompleted++;
        drainResultCounts.already_completed++;
      } else if (result.reason === 'predecessor_pending') {
        // Preserve the row. The predecessor is owned by its own retry or by
        // another process; the causal retry armed for this pass comes back.
        summary.deferred++;
        drainResultCounts.deferred++;
        blockedTables.add(key);
      } else {
        summary.failed++;
        drainResultCounts.failed++;
        blockedTables.add(key);
        reportError(
          new Error(`[HandProjection] hand ${row.hand_number} refused: ${JSON.stringify(result)}`),
          'HandProjection.semantic_refusal'
        );
      }
    } catch (err) {
      summary.failed++;
      drainResultCounts.failed++;
      blockedTables.add(key);
      reportError(err, 'HandProjection.rpc_failed', {
        handId: row.hand_id,
        handNumber: row.hand_number,
      });
    }
  }
}

/**
 * Rows with no table_id (none in production; the column is NOT NULL for every
 * row the settlement RPC writes) share one serial chain so their global
 * hand_number order is still honoured.
 */
function chainKey(row: ProjectionRow): string {
  return row.table_id ?? '';
}

/** One chain per table, in order of each table's first row, rows in hand_number order. */
function chainsByTable(rows: ProjectionRow[]): ProjectionRow[][] {
  const byTable = new Map<string, ProjectionRow[]>();
  for (const row of rows) {
    const key = chainKey(row);
    const chain = byTable.get(key);
    if (chain) chain.push(row);
    else byTable.set(key, [row]);
  }
  return [...byTable.values()];
}

/**
 * Bounded fan-out: at most `concurrency` chains in flight, each strictly
 * ordered inside itself. Chains are taken in first-row order so the oldest
 * outbox row is always among the first started.
 */
async function projectChains(
  chains: ProjectionRow[][],
  concurrency: number,
  blockedTables: Set<string>,
  summary: HandProjectionDrainSummary
): Promise<void> {
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, chains.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (!stopping) {
        const chain = chains[next++];
        if (!chain) return;
        await projectChain(chain, blockedTables, summary);
      }
    })
  );
}

async function runDrain(): Promise<HandProjectionDrainSummary> {
  const summary = emptySummary();
  let cursor = 0;
  let visited = 0;
  const concurrency = handProjectionDrainConcurrency();
  // A table whose chain stopped in an earlier page of this pass stays
  // blocked for the whole pass: its later rows need the same predecessor.
  const blockedTables = new Set<string>();
  drainsTotal++;
  lastDrainStartedAt = Date.now();

  while (!stopping && visited < DRAIN_MAX) {
    const { data, error } = await supabase
      .from('hand_projection_outbox')
      .select('hand_id,table_id,hand_number')
      .gt('hand_number', cursor)
      .order('hand_number', { ascending: true })
      .limit(Math.min(DRAIN_PAGE, DRAIN_MAX - visited));
    if (error) throw new Error(`projection outbox read failed: ${describeError(error)}`);

    const rows = (data ?? []) as ProjectionRow[];
    if (rows.length === 0) break;

    // The page is in global hand_number order, so for every table it holds
    // that table's OLDEST pending rows: no chain starts behind a row this
    // pass has not seen. Pages are projected one after another for the same
    // reason - a table split across two pages keeps its order.
    for (const row of rows) {
      visited++;
      cursor = Math.max(cursor, Number(row.hand_number) || cursor);
    }
    await projectChains(chainsByTable(rows), concurrency, blockedTables, summary);

    if (rows.length < DRAIN_PAGE) break;
  }

  // A bounded drain yields the event loop after DRAIN_MAX rows, but it must
  // not mistake its own work budget for an empty outbox. Queue one coalesced
  // continuation while the current promise still owns the worker. This is
  // event-driven backlog continuation, not a correctness poll or timer.
  if (!stopping && visited >= DRAIN_MAX) wakeAfterDrain = true;

  return summary;
}

function cancelCausalRetry(resetAttempt: boolean): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (resetAttempt) retryAttempt = 0;
}

function armCausalRetry(): void {
  if (!workerActive || stopping || retryTimer) return;
  const epoch = lifecycleEpoch;
  const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 6));
  retryAttempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!workerActive || stopping || lifecycleEpoch !== epoch) return;
    void beginDrain();
  }, delayMs);
  retryTimer.unref?.();
}

/**
 * A DRAIN THAT NEVER SETTLES DISABLES THE ONLY REMAINING WAKE (2026-09-11).
 *
 * `pollIsDue` opens with `if (state.drainRunning) return false`, and
 * `drainRunning` is `drainPromise !== null`. The escape hatch below it - "no
 * drain has STARTED for RETRY_MAX_MS plus two poll intervals, so the retry is
 * not doing its job" - is written for a stuck RETRY and is unreachable for a
 * stuck DRAIN, because the first line has already returned. So one pass whose
 * promise never resolves takes the poll out of service permanently.
 *
 * That is not hypothetical. Measured on engine-01 this evening:
 * `poker_hand_projection_drains_total` frozen at 324 and
 * `..._drain_results_total{result="projected"}` frozen at 73,438 across
 * fifteen minutes, while `poker_hand_projection_outbox_depth` climbed from
 * 24,442 to 27,356 and its oldest row passed fifty-one minutes. The engine was
 * healthy and dealing throughout. The wedge began during an image build on the
 * same host, when the box was at load 20 and every database call was slow.
 *
 * It wedges so completely because the two cross-process wakes are gone: the
 * Realtime channel is in CHANNEL_ERROR (logged repeatedly) and LISTEN is
 * unconfigured on this host. The 5 s poll is the whole net, and this is what
 * switches it off.
 *
 * THE FIX IS TO MAKE THE PROMISE ALWAYS SETTLE, not to let a second drain
 * start beside a first. Ordering inside a table's chain is what this worker
 * exists to preserve, so two concurrent passes is the one thing that must not
 * happen. A bounded pass restores every net that already exists: the promise
 * clears, `pollIsDue` answers again, and the causal retry re-arms.
 */
const DRAIN_DEADLINE_MS = boundedEnvInt(
  'HAND_PROJECTION_DRAIN_DEADLINE_MS',
  120_000,
  10_000,
  600_000
);

/** Reject if the pass has not settled inside its deadline. */
function withDeadline(
  pass: Promise<HandProjectionDrainSummary>,
  budgetMs: number = DRAIN_DEADLINE_MS
): Promise<HandProjectionDrainSummary> {
  return new Promise<HandProjectionDrainSummary>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `[HandProjection] drain pass did not settle within ${budgetMs}ms - ` +
            'releasing the lane so the safety poll can run again'
        )
      );
    }, budgetMs);
    timer.unref?.();
    pass.then(
      (summary) => {
        clearTimeout(timer);
        resolve(summary);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Test seam: the deadline wrapper with an explicit budget. */
export function withDrainDeadlineForTest(
  pass: Promise<HandProjectionDrainSummary>,
  budgetMs: number
): Promise<HandProjectionDrainSummary> {
  return withDeadline(pass, budgetMs);
}

export { DRAIN_DEADLINE_MS as HAND_PROJECTION_DRAIN_DEADLINE_MS };

/** Start or join the one process-wide ordered drain. */
function beginDrain(): Promise<HandProjectionDrainSummary> {
  if (drainPromise) {
    wakeAfterDrain = true;
    return drainPromise;
  }
  const active = withDeadline(runDrain());
  drainPromise = active;
  let causalRetryOwed = false;
  void active
    .then((summary) => {
      causalRetryOwed = summary.failed > 0 || summary.deferred > 0;
    })
    .catch((err) => {
      causalRetryOwed = true;
      reportError(err, 'HandProjection.drain_failed');
    })
    .finally(() => {
      if (drainPromise === active) drainPromise = null;
      if (wakeAfterDrain && workerActive && !stopping) {
        wakeAfterDrain = false;
        void beginDrain();
      } else if (causalRetryOwed && workerActive && !stopping) {
        armCausalRetry();
      } else if (!causalRetryOwed) {
        retryAttempt = 0;
      }
    });
  return active;
}

/**
 * Coalesce every transaction/LISTEN/Realtime/poll work signal onto the active
 * worker. The source is counted even when the worker is inactive so a wake
 * arriving before start or after stop is still visible on /metrics.
 */
export function wakeHandProjection(
  source: HandProjectionWakeSource = 'local'
): Promise<HandProjectionDrainSummary> {
  wakeCounts[source]++;
  if (!workerActive || stopping || !runOwnedDrain) return Promise.resolve(emptySummary());
  // A fresh causal signal supersedes a pending backoff and is permission to
  // try immediately. It also resets the backoff because the dependency state
  // may have changed since the preceding refusal.
  cancelCausalRetry(true);
  return runOwnedDrain();
}

/**
 * Subscribe before the startup drain.  INSERTs committed during the snapshot
 * are therefore delivered live; duplicate wakes are harmless because the
 * outbox row is the database transaction's claim.
 */
export function startHandProjectionWorker(): void {
  if (workerActive) return;
  // Only process startup may establish this worker's authority. A manager
  // can signal existing durable work, never create a service-context escape.
  if (currentTournamentDataAuthority() !== null) {
    throw new Error('Hand projection worker must start outside tournament authority');
  }
  // Capture the worker owner once. An idle drain woken by a tournament must
  // not send global outbox requests under that tournament's lease. This
  // private, zero-argument callback only drains server-owned durable claims.
  runOwnedDrain = AsyncResource.bind(beginDrain, 'HandProjection.worker');
  workerActive = true;
  stopping = false;
  lifecycleEpoch++;
  cancelCausalRetry(true);

  const ch = supabase
    .channel(`hand-projection-outbox:${process.pid}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'hand_projection_outbox' },
      () => {
        void wakeHandProjection('realtime');
      }
    )
    .subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        void wakeHandProjection('realtime');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reportError(
          new Error(`Hand projection outbox channel entered ${status}`),
          'HandProjection.realtime_channel_failed'
        );
      }
    });
  channel = ch;

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // A running drain already owns the outbox and an armed causal retry will
    // drain within RETRY_MAX_MS; a poll on top of either would only queue a
    // redundant pass or reset a deliberate backoff. pollIsDue bounds the
    // second case so a retry can never hold the poll off indefinitely.
    if (!workerActive || stopping) return;
    if (
      !pollIsDue({
        drainRunning: drainPromise !== null,
        retryArmed: retryTimer !== null,
        msSinceLastDrainStart: Date.now() - lastDrainStartedAt,
        pollMs: HAND_PROJECTION_POLL_MS,
      })
    )
      return;
    void wakeHandProjection('poll').catch((err) =>
      reportError(err, 'HandProjection.poll_wake_failed')
    );
  }, HAND_PROJECTION_POLL_MS);
  pollTimer.unref?.();

  // Also drain immediately.  This covers a process that starts while Realtime
  // and LISTEN are unavailable; normal local commits still wake this worker
  // directly.
  void wakeHandProjection('startup');
}

export async function stopHandProjectionWorker(): Promise<void> {
  workerActive = false;
  stopping = true;
  runOwnedDrain = null;
  lifecycleEpoch++;
  wakeAfterDrain = false;
  cancelCausalRetry(true);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  const ch = channel;
  channel = null;
  if (ch) {
    await Promise.resolve(supabase.removeChannel(ch)).catch((err) =>
      reportError(err, 'HandProjection.realtime_channel_remove_failed')
    );
  }
  // Join by identity. A drain's completion callback cannot create another one
  // after the lifecycle fence, but the loop makes that ownership guarantee
  // explicit and protects future continuation changes.
  while (drainPromise) {
    const active = drainPromise;
    await active.catch(() => undefined);
    if (drainPromise === active) drainPromise = null;
  }
}
