/** Worker-thread entry point for the live HorseLogic decision lane. */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import type { HorseDecisionWorkerRequest } from './protocol.js';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
  startOwnedServices,
} from './workerRuntime.js';
import { lowerDecisionWorkerPriority } from './workerPriority.js';

/** This worker's position among its decision-lane peers, from the
 * `workerData` client.ts's defaultWorkerFactory posts at creation; absent
 * (a caller that predates sharding, or a test harness) is shard 0 - the one
 * archive this journal has always used (see startHorseDecisionJournal). */
function shardFromWorkerData(data: unknown): { index: number } | undefined {
  const shardIndex = (data as { shardIndex?: unknown } | null)?.shardIndex;
  return typeof shardIndex === 'number' && Number.isSafeInteger(shardIndex) && shardIndex >= 0
    ? { index: shardIndex }
    : undefined;
}

if (!isMainThread && parentPort) {
  // Before any solver store loads: the main loop keeps the core whenever the
  // two of them want it (workerPriority.ts).
  const priority = lowerDecisionWorkerPriority();
  console.log(
    `[HorseDecisionWorker] thread priority ${priority.status}` +
      (priority.tid !== null ? ` tid ${priority.tid}` : '') +
      (priority.nice !== null ? ` nice ${priority.nice}` : '') +
      (priority.reason ? ` (${priority.reason})` : '')
  );
  const shard = shardFromWorkerData(workerData);
  const deps = shard
    ? { ...defaultHorseDecisionWorkerDependencies, startServices: () => startOwnedServices(shard) }
    : defaultHorseDecisionWorkerDependencies;
  const port = parentPort;
  const runtime = new HorseDecisionWorkerRuntime((message) => port.postMessage(message), deps);
  port.on('message', (message: HorseDecisionWorkerRequest) => runtime.receive(message));
  void runtime.start();
}
