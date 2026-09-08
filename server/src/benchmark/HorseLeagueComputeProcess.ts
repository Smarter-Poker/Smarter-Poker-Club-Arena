/**
 * Low-priority process boundary for production Horse League analysis.
 *
 * A worker thread shares the engine process niceness, so its offline simulator
 * competes equally with the authoritative event loop, live HorseLogic, and
 * insurance/equity workers on the 3-vCPU engine host. This bootstrap changes
 * its own OS scheduling priority before loading any solver data or simulator
 * code. If the kernel cannot certify that boundary, the analysis process exits
 * and the durable league claim remains retryable; live poker is never asked to
 * donate a core to an unisolated benchmark.
 */

import { constants as osConstants, getPriority, setPriority } from 'node:os';

import type { HorseLeagueComputeResponse } from './HorseLeagueComputeProtocol.js';

function sendFailure(error: unknown): void {
  const response: HorseLeagueComputeResponse = {
    type: 'ERROR',
    jobId: null,
    message: error instanceof Error ? error.message : String(error),
  };
  process.send?.(response);
}

try {
  setPriority(0, osConstants.priority.PRIORITY_LOW);
  const actual = getPriority(0);
  if (actual !== osConstants.priority.PRIORITY_LOW) {
    throw new Error(
      `horse league compute process nice verification failed: expected ${osConstants.priority.PRIORITY_LOW}, received ${actual}`
    );
  }
  await import('./HorseLeagueComputeWorker.js');
} catch (error) {
  sendFailure(error);
  process.exitCode = 1;
}
