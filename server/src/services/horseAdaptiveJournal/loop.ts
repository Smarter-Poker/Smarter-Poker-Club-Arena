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
 * independent failure backoff still apply. Keep journal work the majority. */
export const CAPTURE_FAIRNESS_JOURNAL_TURNS = 8;

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

/** A single serial consumer. One claim and at most one bounded prune per
 * cycle; never imports this loop into the table's action or decision worker. */
export async function runJournalLoop(signal: AbortSignal, d: Dependencies): Promise<void> {
  let nextPruneAt = 0;
  let nextHealthAt = 0;
  let failures = 0;
  let captureFailures = 0;
  let captureNext = false;
  let captureFromBacklog = false;
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
    if (captureNext && d.processCapture) {
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
      const healthy = ['idle', 'admitted', 'continued', 'captured', 'refined'].includes(
        capture.status
      );
      captureFailures = healthy ? 0 : Math.min(captureFailures + 1, 6);
      const delay = healthy
        ? capture.status === 'idle' && !captureFromBacklog
          ? 5000
          : 1000
        : Math.min(60000, 1000 * 2 ** captureFailures);
      try {
        await pause(delay);
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
    if (d.now() >= nextPruneAt) {
      try {
        const tasks = [
          d.prune,
          ...(d.pruneCaptures ? [d.pruneCaptures] : []),
          ...(d.pruneDiscovery ? [d.pruneDiscovery] : []),
        ];
        const task = tasks[pruneIndex % tasks.length];
        pruneIndex = (pruneIndex + 1) % tasks.length;
        const r = await task();
        retention = r.status;
        const atLimit =
          r.status === 'pruned' &&
          ('epochs' in r
            ? r.members === 512 || r.segments === 128 || r.epochs === 1
            : 'requests' in r
              ? r.requests === 100 || r.sliceReceipts === 1000
              : r.completedWork === 100 || r.batches === 100 || r.observations === 1000);
        nextPruneAt = d.now() + (atLimit ? 5000 : 60000);
      } catch {
        retention = 'unknown';
        nextPruneAt = d.now() + 60000;
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
    captureFromBacklog = result.status !== 'idle';
    captureNext =
      Boolean(d.processCapture) &&
      (result.status === 'idle' || journalTurns >= CAPTURE_FAIRNESS_JOURNAL_TURNS);
    const healthy = result.status === 'completed' || result.status === 'idle';
    failures = healthy ? 0 : Math.min(failures + 1, 6);
    const delay = healthy
      ? result.status === 'idle'
        ? captureNext
          ? 1000
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
