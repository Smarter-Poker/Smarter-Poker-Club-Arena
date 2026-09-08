/**
 * Work-triggered hand projection worker.
 *
 * The accepted-hand RPC commits money, history, tournament chip state and one
 * durable outbox row.  Dashboard/stat/mission projections are intentionally
 * outside that locking path.  This worker is woken by the committing engine,
 * by Realtime, and once at process start. There is no periodic poll. A failed
 * or dependency-deferred claim owns one bounded exponential retry chain until
 * it commits; that chain is caused by the unresolved durable row and is fenced
 * and joined by the worker lifecycle.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

type ProjectionRow = {
  hand_id: string;
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
    if (error) throw error;
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
  if (targetError) throw targetError;
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
  if (earlierError) throw earlierError;
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

let channel: ReturnType<typeof supabase.channel> | null = null;
let drainPromise: Promise<HandProjectionDrainSummary> | null = null;
let wakeAfterDrain = false;
let stopping = false;
let workerActive = false;
let lifecycleEpoch = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function emptySummary(): HandProjectionDrainSummary {
  return { projected: 0, alreadyCompleted: 0, deferred: 0, failed: 0 };
}

async function runDrain(): Promise<HandProjectionDrainSummary> {
  const summary = emptySummary();
  let cursor = 0;
  let visited = 0;

  while (!stopping && visited < DRAIN_MAX) {
    const { data, error } = await supabase
      .from('hand_projection_outbox')
      .select('hand_id,hand_number')
      .gt('hand_number', cursor)
      .order('hand_number', { ascending: true })
      .limit(Math.min(DRAIN_PAGE, DRAIN_MAX - visited));
    if (error) throw error;

    const rows = (data ?? []) as ProjectionRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (stopping) break;
      visited++;
      cursor = Math.max(cursor, Number(row.hand_number) || cursor);
      try {
        const { data: projected, error: projectError } = await supabase.rpc(
          'fn_project_hand_side_effects',
          { p_hand_id: row.hand_id }
        );
        if (projectError) throw projectError;
        const result = (projected ?? {}) as ProjectionResult;
        if (result.ok === true) {
          summary.projected++;
        } else if (result.reason === 'not_pending') {
          // Another engine process owned the same durable row and committed
          // before this RPC acquired it.  No projection was skipped.
          summary.alreadyCompleted++;
        } else if (result.reason === 'predecessor_pending') {
          // Preserve the row.  The predecessor's successful worker continues
          // through the same ordered outbox and will reach it in this pass.
          summary.deferred++;
        } else {
          summary.failed++;
          reportError(
            new Error(
              `[HandProjection] hand ${row.hand_number} refused: ${JSON.stringify(result)}`
            ),
            'HandProjection.semantic_refusal'
          );
        }
      } catch (err) {
        summary.failed++;
        reportError(err, 'HandProjection.rpc_failed', {
          handId: row.hand_id,
          handNumber: row.hand_number,
        });
      }
    }

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

/** Start or join the one process-wide ordered drain. */
function beginDrain(): Promise<HandProjectionDrainSummary> {
  if (drainPromise) {
    wakeAfterDrain = true;
    return drainPromise;
  }
  const active = runDrain();
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

/** Coalesce every transaction/Realtime work signal onto the active worker. */
export function wakeHandProjection(): Promise<HandProjectionDrainSummary> {
  if (!workerActive || stopping) return Promise.resolve(emptySummary());
  // A fresh causal signal supersedes a pending backoff and is permission to
  // try immediately. It also resets the backoff because the dependency state
  // may have changed since the preceding refusal.
  cancelCausalRetry(true);
  return beginDrain();
}

/**
 * Subscribe before the startup drain.  INSERTs committed during the snapshot
 * are therefore delivered live; duplicate wakes are harmless because the
 * outbox row is the database transaction's claim.
 */
export function startHandProjectionWorker(): void {
  if (workerActive) return;
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
        void wakeHandProjection();
      }
    )
    .subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        void wakeHandProjection();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reportError(
          new Error(`Hand projection outbox channel entered ${status}`),
          'HandProjection.realtime_channel_failed'
        );
      }
    });
  channel = ch;

  // Also drain immediately.  This covers a process that starts while Realtime
  // is unavailable; normal local commits still wake this worker directly.
  void wakeHandProjection();
}

export async function stopHandProjectionWorker(): Promise<void> {
  workerActive = false;
  stopping = true;
  lifecycleEpoch++;
  wakeAfterDrain = false;
  cancelCausalRetry(true);
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
