import { emptyCommittedPotAudit, type CommittedPotAuditReceipt } from './commitmentReceipt.js';
import type { AdaptiveJournalWorkResult } from '../HorseAdaptiveJournalWork.js';
import type { JournaledModelCycle } from '../HorseJournaledOpponentModels.js';
import type { pruneAdaptiveJournal } from '../HorseAdaptiveJournalRetention.js';
import type { JournalQueueHealth } from './queueHealth.js';
import { unknownDiscovery, type DiscoveryReceipt } from './discoveryReceipt.js';
import type { pruneObservationDiscovery } from '../HorseObservationDiscovery.js';
import type {
  ObservationCaptureResult,
  pruneObservationCaptures,
} from '../HorseObservationCapture.js';

export type JournalCycle = Readonly<{
  work: AdaptiveJournalWorkResult['status'] | 'skipped';
  retention: 'skipped' | Awaited<ReturnType<typeof pruneAdaptiveJournal>>['status'];
  acquisition?: ObservationCaptureResult['status'];
  discovery?: DiscoveryReceipt;
  model?: JournaledModelCycle;
  commitment?: CommittedPotAuditReceipt;
}>;
type Dependencies = {
  processWork: () => Promise<AdaptiveJournalWorkResult>;
  processCapture?: () => Promise<ObservationCaptureResult>;
  discover?: () => Promise<DiscoveryReceipt>;
  processModels?: () => Promise<JournaledModelCycle>;
  processCommitments?: () => Promise<CommittedPotAuditReceipt>;
  prune: typeof pruneAdaptiveJournal;
  pruneCaptures?: typeof pruneObservationCaptures;
  pruneDiscovery?: typeof pruneObservationDiscovery;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  started: () => void;
  completed: (cycle: JournalCycle) => void;
  readQueueHealth?: () => Promise<JournalQueueHealth>;
  queueHealth?: (health: JournalQueueHealth) => void;
};

/** Bound acquisition starvation in turns, not wall time: RPC timeouts and
 * independent failure backoff still apply. Keep journal work the majority
 * while the journal has a backlog of its own. */
export const CAPTURE_FAIRNESS_JOURNAL_TURNS = 8;

/** HORSE CAPTURE DRAINS IN ORDER (2026-10-25). Measured on production
 * 2026-10-24 with the journal queue empty: one capture slice, a 1 s pause, a
 * journal turn, another 1 s pause, about 17 s a capture, while discovery
 * created three to four times the slices one consumer then read. The journal
 * has no work of its own unless capture put it there:
 * fn_finish_horse_observation_capture is the only caller of
 * fn_queue_horse_adaptive_batch. So while the journal is idle, capture slices
 * run back to back: capture, the journal turn that records its batch, one
 * more journal claim that finds nothing, capture, with no pause between. The
 * fairness pause and the eight-turn rule apply only when the journal has work
 * of its own: a completed batch it was not just handed by capture. */
export const CAPTURE_BACK_TO_BACK_PAUSE_MS = 0;
const CAPTURE_PRODUCED_BATCH = new Set(['admitted', 'continued', 'captured']);
const CAPTURE_PROGRESS = new Set(['admitted', 'continued', 'captured', 'refined']);

/** The daily gross >10BB commitment audit keeps its own clock, independent of
 * how many journal turns have run. Measured in production on 2026-10-07: one
 * `fn_horse_commitment_audit_step` call scans 256 hand_history rows (mean
 * 241 ms, max 2.4 s, statement_timeout 5 s), and ~1.3 million hands are
 * accepted a day. Gated behind four journal turns the step ran about once
 * every 52 s, ~425,000 hands a day, so days left the today-1..today-3 window
 * unfinished (2026-10-04 reached 13:51 of its day after ~61 hours).
 *
 * A 'recorded' receipt means exactly 256 rows were scanned, so a backlog
 * remains: the next step is due 5 s later. 5 s x 256 = ~4.4 million hands a
 * day of capacity, more than 3x the daily volume, at ~5% of one database
 * backend while backlogged (241 ms every 5 s). */
export const COMMITMENT_AUDIT_BACKLOG_DELAY_MS = 5000;
/** Every other receipt ('pass_complete', 'idle', 'busy', 'disabled' or
 * 'unknown', including a thrown or unreadable step) keeps the slower
 * one-minute retry. */
export const COMMITMENT_AUDIT_SETTLED_DELAY_MS = 60000;
/** A step runs inside the loop's existing pause between cycles, and only
 * where at least this much of the pause is left to absorb it before the next
 * journal turn: the shortest pause the loop takes (1 s) against a measured
 * mean step of 241 ms. A rare slow step (max 2.4 s; transport ceiling 5 s)
 * can still run past the pause, exactly as it could under the old cadence. */
export const COMMITMENT_AUDIT_STEP_ALLOWANCE_MS = 1000;

/** A v3 adaptive retention pass that reports retirement still pending (or its
 * budget reached) is revisited after this delay instead of the generic 5 s.
 * Measured on production 2026-10-15: about 14 hands a second qualify, and a
 * full pass retires about 240 in about 4.9 s. At a 5 s revisit the lane
 * peaks near 24 a second with no headroom for a slow pass; at 1 s it peaks
 * near 40. Appends share the capacity lock and retry through journal work:
 * a six-hour continuous drain holding the lane left no journal work
 * unfinished. Every other owner and receipt keeps its existing deadline. */
export const ADAPTIVE_RETIREMENT_BACKLOG_DELAY_MS = 1000;

/** A single serial consumer. One claim and at most one bounded prune per
 * cycle; never imports this loop into the table's action or decision worker. */
export async function runJournalLoop(signal: AbortSignal, d: Dependencies): Promise<void> {
  const pruneTasks = [
    d.prune,
    ...(d.pruneCaptures ? [d.pruneCaptures] : []),
    ...(d.pruneDiscovery ? [d.pruneDiscovery] : []),
  ];
  // Each original owner keeps its own deadline. An idle or failed sibling
  // must not postpone a bounded adaptive pass with membership still pending.
  const nextPruneAt = pruneTasks.map(() => 0);
  let nextHealthAt = 0;
  let failures = 0;
  let captureFailures = 0;
  let nextCaptureAt = 0;
  let captureNext = false;
  let captureFromBacklog = false;
  // The last capture moved its request forward (a batch or a narrower slice).
  let captureProgress: boolean = false;
  // The last capture produced a batch while the journal had no work of its
  // own, so the next journal turn is recording that batch, not a backlog.
  let captureBatchPending: boolean = false;
  let journalTurns = 0;
  let pruneIndex = 0;
  let nextDiscoveryAt = 0;
  let discoveryEligible = false;
  let discoveryFailures = 0;
  let nextCommitmentAt = 0;
  let modelTurns = 0;
  let nextModelAt = 0;
  // One bounded, separately recoverable commitment-audit step. Its cursor is
  // durable in the database, so an interrupted step is discarded here and the
  // next step continues from that cursor.
  const auditCommitments = async (process: () => Promise<CommittedPotAuditReceipt>) => {
    d.started();
    let commitment: CommittedPotAuditReceipt;
    try {
      commitment = await process();
    } catch {
      commitment = emptyCommittedPotAudit('unknown');
    }
    if (signal.aborted) return;
    d.completed(Object.freeze({ work: 'skipped', retention: 'skipped', commitment }));
    nextCommitmentAt =
      d.now() +
      (commitment.status === 'recorded'
        ? COMMITMENT_AUDIT_BACKLOG_DELAY_MS
        : COMMITMENT_AUDIT_SETTLED_DELAY_MS);
  };
  // Every pause the loop already takes between its own cycles. The audit runs
  // inside these pauses on its own deadline, so it never waits for journal
  // turns and never takes a turn from them: the next journal cycle still
  // starts `ms` after the pause began. A step that is already due runs at the
  // start of the pause; one falling due later runs on time when at least
  // COMMITMENT_AUDIT_STEP_ALLOWANCE_MS of the pause is left, otherwise at the
  // start of the next pause. The loop is serial, so two steps never overlap
  // and no step overlaps journal, capture, discovery or model work.
  const pause = async (ms: number): Promise<void> => {
    if (ms <= 0) {
      // Back to back: no pause, but a due audit step still runs on its own
      // deadline, and the loop still yields once to the event loop so the
      // worker's heartbeat and a STOP message are never starved.
      if (d.processCommitments && !signal.aborted && nextCommitmentAt - d.now() <= 0)
        await auditCommitments(d.processCommitments);
      if (!signal.aborted) await d.wait(0, signal);
      return;
    }
    const until = d.now() + ms;
    const process = d.processCommitments;
    while (!signal.aborted) {
      const remaining = until - d.now();
      const due = process ? nextCommitmentAt - d.now() : Infinity;
      if (process && due <= 0) {
        await auditCommitments(process);
        continue;
      }
      if (remaining - due >= COMMITMENT_AUDIT_STEP_ALLOWANCE_MS) {
        await d.wait(due, signal);
        continue;
      }
      if (remaining > 0) await d.wait(remaining, signal);
      return;
    }
  };
  while (!signal.aborted) {
    d.started();
    if (d.discover && discoveryEligible && d.now() >= nextDiscoveryAt) {
      discoveryEligible = false;
      let discovery: DiscoveryReceipt;
      try {
        discovery = await d.discover();
      } catch {
        discovery = unknownDiscovery();
      }
      if (signal.aborted) return;
      d.completed(Object.freeze({ work: 'skipped', retention: 'skipped', discovery }));
      const progress = [
        'source_recorded',
        'admitted',
        'advanced',
        'discovered',
        'refined',
      ].includes(discovery.status);
      discoveryFailures =
        progress || discovery.status === 'idle' ? 0 : Math.min(6, discoveryFailures + 1);
      nextDiscoveryAt =
        d.now() +
        (progress
          ? 10000
          : discovery.status === 'idle' || discovery.status === 'gap'
            ? 60000
            : Math.max(10000, Math.min(60000, 1000 * 2 ** discoveryFailures)));
      // Backoff is a deadline for discovery alone. At least one ordinary
      // work/capture cycle runs before discovery becomes eligible again.
      try {
        await pause(1000);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      continue;
    }
    discoveryEligible = true;
    // One separately bounded model cycle after eight ordinary journal turns.
    // Neither discovery nor model failure can consume the other's deadline.
    if (d.processModels && modelTurns >= 8 && d.now() >= nextModelAt) {
      modelTurns = 0;
      let model: JournaledModelCycle;
      try {
        model = await d.processModels();
      } catch {
        model = 'unknown';
      }
      if (signal.aborted) return;
      d.completed(Object.freeze({ work: 'skipped', retention: 'skipped', model }));
      nextModelAt = d.now() + (model === 'recorded' || model === 'refused' ? 1000 : 60000);
      try {
        await pause(1000);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      continue;
    }
    if (captureNext && d.processCapture && d.now() >= nextCaptureAt) {
      // Acquisition has up to three bounded RPCs. Keep maintenance/health in
      // ordinary journal cycles so this cycle remains below the watchdog.
      captureNext = false;
      journalTurns = 0;
      let capture: ObservationCaptureResult;
      try {
        capture = await d.processCapture();
      } catch {
        capture = { status: 'unavailable', reason: 'capture_unavailable' };
      }
      if (signal.aborted) return;
      d.completed(
        Object.freeze({ work: 'skipped', retention: 'skipped', acquisition: capture.status })
      );
      // A terminal source gap durably retires one request. It is not a
      // transport failure: backing off each expired request for a minute
      // lets readable requests behind it expire too. Preserve its gap receipt
      // and ordinary fairness pause, but reset only the capture error backoff.
      const healthy = ['idle', 'admitted', 'continued', 'captured', 'refined', 'gap'].includes(
        capture.status
      );
      captureFailures = healthy ? 0 : Math.min(captureFailures + 1, 6);
      captureProgress = CAPTURE_PROGRESS.has(capture.status);
      // Back to back only while the journal has no work of its own.
      const backToBack: boolean = captureProgress && !captureFromBacklog;
      captureBatchPending = backToBack && CAPTURE_PRODUCED_BATCH.has(capture.status);
      const delay = healthy
        ? backToBack
          ? CAPTURE_BACK_TO_BACK_PAUSE_MS
          : capture.status === 'idle' && !captureFromBacklog
            ? 5000
            : 1000
        : Math.min(60000, 1000 * 2 ** captureFailures);
      // Capture backoff belongs to capture alone. Continue the existing
      // journal/retention turns while its retry deadline is still pending.
      nextCaptureAt = healthy ? 0 : d.now() + delay;
      try {
        await pause(healthy ? delay : 1000);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      continue;
    }
    let result: AdaptiveJournalWorkResult;
    try {
      result = await d.processWork();
    } catch {
      result = { status: 'unavailable', reason: 'work_unavailable' };
    }
    if (signal.aborted) return;
    let retention: JournalCycle['retention'] = 'skipped';
    let duePrune = -1;
    for (let offset = 0; offset < pruneTasks.length; offset++) {
      const index = (pruneIndex + offset) % pruneTasks.length;
      if (d.now() >= nextPruneAt[index]) {
        duePrune = index;
        break;
      }
    }
    if (duePrune >= 0) {
      pruneIndex = (duePrune + 1) % pruneTasks.length;
      try {
        const task = pruneTasks[duePrune];
        const r = await task();
        retention = r.status;
        const atLimit =
          r.status === 'pruned' &&
          ('epochs' in r
            ? r.members === 512 || r.segments === 128 || r.epochs === 1
            : 'requests' in r
              ? r.requests === 100 || r.sliceReceipts === 1000
              : r.completedWork === 100 ||
                r.batches === 100 ||
                r.observations === 1000 ||
                ('retirementPending' in r
                  ? r.retirementPending === true || r.budgetReached === true
                  : 'retiredHands' in r && r.retiredHands === 25) ||
                ('statisticsExpired' in r && r.statisticsExpired === 1000) ||
                ('membershipPending' in r && r.membershipPending === true));
        const retirementBacklog =
          r.status === 'pruned' &&
          'retirementPending' in r &&
          (r.retirementPending === true || r.budgetReached === true);
        nextPruneAt[duePrune] =
          d.now() +
          (retirementBacklog ? ADAPTIVE_RETIREMENT_BACKLOG_DELAY_MS : atLimit ? 5000 : 60000);
      } catch {
        retention = 'unknown';
        nextPruneAt[duePrune] = d.now() + 60000;
      }
    }
    if (signal.aborted) return;
    if (d.readQueueHealth && d.now() >= nextHealthAt) {
      let health: JournalQueueHealth;
      try {
        health = await d.readQueueHealth();
      } catch {
        health = { status: 'unknown' };
      }
      nextHealthAt = d.now() + 60000;
      if (signal.aborted) return;
      d.queueHealth?.(health);
    }
    d.completed(Object.freeze({ work: result.status, retention }));
    modelTurns = Math.min(modelTurns + 1, 8);
    if (d.processCapture) journalTurns = Math.min(journalTurns + 1, CAPTURE_FAIRNESS_JOURNAL_TURNS);
    // Completing the batch the last capture produced is not yet evidence of a
    // backlog. The journal is asked once more straight away: idle means it
    // has no work of its own and the next capture follows at once; another
    // completed batch is a real backlog and keeps the fairness pause.
    const ownBatch: boolean = captureBatchPending && result.status === 'completed';
    captureBatchPending = false;
    const journalIdle = result.status === 'idle';
    captureFromBacklog = !journalIdle && !ownBatch;
    captureNext =
      Boolean(d.processCapture) && (journalIdle || journalTurns >= CAPTURE_FAIRNESS_JOURNAL_TURNS);
    const healthy = result.status === 'completed' || result.status === 'idle';
    failures = healthy ? 0 : Math.min(failures + 1, 6);
    const delay = healthy
      ? ownBatch
        ? CAPTURE_BACK_TO_BACK_PAUSE_MS
        : journalIdle
          ? captureNext
            ? captureProgress
              ? CAPTURE_BACK_TO_BACK_PAUSE_MS
              : 1000
            : 5000
          : 1000
      : Math.min(60000, 1000 * 2 ** failures);
    try {
      await pause(delay);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
