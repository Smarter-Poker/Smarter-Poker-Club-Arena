/** Worker-thread entry point for the live HorseLogic decision lane. */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import type { HorseDecisionWorkerRequest } from './protocol.js';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
  startOwnedServices,
} from './workerRuntime.js';
import { lowerDecisionWorkerPriority } from './workerPriority.js';
import { prespawnHorseDecisionJournalWriter } from '../../services/HorseDecisionJournal.js';

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
  const shard = shardFromWorkerData(workerData);
  // The journal writer thread is created FIRST. A thread inherits the
  // priority of the thread that creates it, and the next call lowers this
  // one to nice 10: a writer made after it would run at nice 10 as well and
  // starve behind the fleet (HorseDecisionJournal.ts, "the writer thread must
  // not be born nice"). Nothing else runs on this thread in between.
  prespawnHorseDecisionJournalWriter(shard);
  // Before any solver store loads: the main loop keeps the core whenever the
  // two of them want it (workerPriority.ts).
  const priority = lowerDecisionWorkerPriority();
  console.log(
    `[HorseDecisionWorker] thread priority ${priority.status}` +
      (priority.tid !== null ? ` tid ${priority.tid}` : '') +
      (priority.nice !== null ? ` nice ${priority.nice}` : '') +
      (priority.reason ? ` (${priority.reason})` : '')
  );
  const deps = shard
    ? { ...defaultHorseDecisionWorkerDependencies, startServices: () => startOwnedServices(shard) }
    : defaultHorseDecisionWorkerDependencies;
  const port = parentPort;
  const runtime = new HorseDecisionWorkerRuntime((message) => port.postMessage(message), deps);
  port.on('message', (message: HorseDecisionWorkerRequest) => runtime.receive(message));
  void runtime.start();
}
