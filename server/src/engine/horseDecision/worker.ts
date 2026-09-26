/** Worker-thread entry point for the live HorseLogic decision lane. */

import { isMainThread, parentPort } from 'node:worker_threads';

import type { HorseDecisionWorkerRequest } from './protocol.js';
import { HorseDecisionWorkerRuntime } from './workerRuntime.js';
import { lowerDecisionWorkerPriority } from './workerPriority.js';

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
  const port = parentPort;
  const runtime = new HorseDecisionWorkerRuntime((message) => port.postMessage(message));
  port.on('message', (message: HorseDecisionWorkerRequest) => runtime.receive(message));
  void runtime.start();
}
