/** Worker-thread entry point for the live HorseLogic decision lane. */

import { isMainThread, parentPort } from 'node:worker_threads';

import type { HorseDecisionWorkerRequest } from './protocol.js';
import { HorseDecisionWorkerRuntime } from './workerRuntime.js';

if (!isMainThread && parentPort) {
  const port = parentPort;
  // Load production authority only in the actual local worker thread. A pure
  // runtime import must never fall back to service-role-backed dependencies.
  const { localHorseDecisionWorkerDependencies } = await import('./localDependencies.js');
  const runtime = new HorseDecisionWorkerRuntime(
    (message) => port.postMessage(message),
    localHorseDecisionWorkerDependencies
  );
  port.on('message', (message: HorseDecisionWorkerRequest) => runtime.receive(message));
  void runtime.start();
}
