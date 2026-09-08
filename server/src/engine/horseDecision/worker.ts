/** Worker-thread entry point for the live HorseLogic decision lane. */

import { isMainThread, parentPort } from 'node:worker_threads';

import type { HorseDecisionWorkerRequest } from './protocol.js';
import { HorseDecisionWorkerRuntime } from './workerRuntime.js';

if (!isMainThread && parentPort) {
  const port = parentPort;
  const runtime = new HorseDecisionWorkerRuntime((message) => port.postMessage(message));
  port.on('message', (message: HorseDecisionWorkerRequest) => runtime.receive(message));
  void runtime.start();
}
