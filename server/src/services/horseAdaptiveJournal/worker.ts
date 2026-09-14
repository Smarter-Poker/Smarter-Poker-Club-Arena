import { isMainThread, parentPort } from 'node:worker_threads';
import { setTimeout as wait } from 'node:timers/promises';
import { runJournalLoop } from './loop.js';

if (isMainThread || !parentPort) throw new Error('Adaptive journal requires its isolated worker');
const port = parentPort;
const stop = new AbortController();
port.on('message', (m: unknown) => {
  if (m && typeof m === 'object' && 'type' in m && m.type === 'STOP') stop.abort();
});
const heartbeat = setInterval(() => port.postMessage({ type: 'HEARTBEAT' }), 5000);
try {
  // Loading/parsing public batches and service transport stays in this
  // dedicated thread. No source payload or service credential crosses IPC.
  const { processAdaptiveJournalWork } = await import('../HorseAdaptiveJournalWork.js');
  const { pruneAdaptiveJournal } = await import('../HorseAdaptiveJournalRetention.js');
  const { readLearningQueueHealth } = await import('../HorseLearningQueueHealth.js');
  const { processObservationCapture, pruneObservationCaptures } =
    await import('../HorseObservationCapture.js');
  if (!stop.signal.aborted) {
    port.postMessage({ type: 'READY' });
    await runJournalLoop(stop.signal, {
      processWork: processAdaptiveJournalWork,
      processCapture: processObservationCapture,
      prune: pruneAdaptiveJournal,
      pruneCaptures: pruneObservationCaptures,
      readQueueHealth: async () => {
        const health = await readLearningQueueHealth();
        port.postMessage({ type: 'CAPTURE_HEALTH', value: { version: 1, ...health.capture } });
        return health.journal;
      },
      queueHealth: (health) =>
        port.postMessage({ type: 'QUEUE_HEALTH', value: { version: 1, ...health } }),
      now: Date.now,
      wait: async (ms, signal) => {
        await wait(ms, undefined, { signal });
      },
      started: () => port.postMessage({ type: 'CYCLE_STARTED' }),
      completed: (cycle) => port.postMessage({ type: 'CYCLE_COMPLETED', ...cycle }),
    });
  }
  port.postMessage({ type: 'STOPPED' });
} catch {
  port.postMessage({ type: 'FAILED' });
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  port.close();
  // Imported service libraries may own handles. Work above has settled or
  // become explicitly unknown; exiting releases this isolated generation.
  process.exit(process.exitCode ?? 0);
}
