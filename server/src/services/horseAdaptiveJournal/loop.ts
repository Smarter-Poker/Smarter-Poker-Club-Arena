import type { AdaptiveJournalWorkResult } from '../HorseAdaptiveJournalWork.js';
import type { pruneAdaptiveJournal } from '../HorseAdaptiveJournalRetention.js';
import type { JournalQueueHealth } from './queueHealth.js';

export type JournalCycle = Readonly<{
  work: AdaptiveJournalWorkResult['status'];
  retention: 'skipped' | Awaited<ReturnType<typeof pruneAdaptiveJournal>>['status'];
}>;
type Dependencies = {
  processWork: () => Promise<AdaptiveJournalWorkResult>;
  prune: typeof pruneAdaptiveJournal;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  started: () => void;
  completed: (cycle: JournalCycle) => void;
  readQueueHealth?: () => Promise<JournalQueueHealth>;
  queueHealth?: (health: JournalQueueHealth) => void;
};

/** A single serial consumer. One claim and at most one bounded prune per
 * cycle; never imports this loop into the table's action or decision worker. */
export async function runJournalLoop(signal: AbortSignal, d: Dependencies): Promise<void> {
  let nextPruneAt = 0;
  let nextHealthAt = 0;
  let failures = 0;
  while (!signal.aborted) {
    d.started();
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
        const r = await d.prune();
        retention = r.status;
        const atLimit =
          r.status === 'pruned' &&
          (r.completedWork === 100 || r.batches === 100 || r.observations === 1000);
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
    const healthy = result.status === 'completed' || result.status === 'idle';
    failures = healthy ? 0 : Math.min(failures + 1, 6);
    const delay = healthy
      ? result.status === 'idle'
        ? 5000
        : 1000
      : Math.min(60000, 1000 * 2 ** failures);
    try {
      await d.wait(delay, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
