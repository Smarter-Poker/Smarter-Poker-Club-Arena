/**
 * Low-priority process boundary for production Horse League analysis.
 *
 * A worker thread shares the engine process niceness, so its offline simulator
 * competes equally with the authoritative event loop, live HorseLogic, and
 * insurance/equity workers on the 3-vCPU engine host. The launcher establishes
 * priority before Node creates helper threads; this bootstrap verifies their
 * inherited priority before loading any solver data or simulator code. If that
 * boundary is absent, the analysis process exits and the durable league claim
 * remains retryable; live poker is never asked to
 * donate a core to an unisolated benchmark.
 */

import { verifyHorseLeagueBootstrapPriority } from './HorseLeagueProcessPriority.js';

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
  verifyHorseLeagueBootstrapPriority();
  await import('./HorseLeagueComputeWorker.js');
} catch (error) {
  sendFailure(error);
  process.exitCode = 1;
}
