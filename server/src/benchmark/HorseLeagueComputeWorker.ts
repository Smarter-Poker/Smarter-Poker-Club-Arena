/**
 * Compute-runtime entry point for the Horse League.
 *
 * The nightly duplicate-deal card is production analysis, not table state. It
 * used to execute thousands of full HorseLogic decisions on the live engine's
 * only event loop. Production loads it inside a lowest-priority child process;
 * focused tests may load it in a worker thread. Both runtimes own an isolated
 * RNG, HorseMind sandbox and solver stores.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { getPriority } from 'node:os';

import { runMatchup } from './HorseLeague.js';
import { scoreSolverAgreement } from './HorseSolverAgreement.js';
import { gtoChartCount } from '../engine/GtoCharts.js';
import { gtoPostflopCount } from '../engine/GtoPostflop.js';
import { gtoPostflopV31Count } from '../engine/GtoPostflopV31.js';
import { loadGtoCharts } from '../services/GtoChartLoader.js';
import { loadGtoPostflop } from '../services/GtoPostflopLoader.js';
import { loadGtoPostflopV31 } from '../services/GtoPostflopV31Loader.js';
import type {
  HorseLeagueComputeRequest,
  HorseLeagueComputeResponse,
} from './HorseLeagueComputeProtocol.js';

interface WorkerOptions {
  /** Test-only escape hatch. Production always hydrates all solver stores. */
  hydrateSolverStores?: boolean;
}

const runtimeAvailable =
  (!isMainThread && parentPort !== null) || typeof process.send === 'function';

if (runtimeAvailable) {
  const options = (
    parentPort
      ? (workerData ?? {})
      : { hydrateSolverStores: process.env.HORSE_LEAGUE_HYDRATE_SOLVER_STORES !== '0' }
  ) as WorkerOptions;
  const cancelled = new Set<number>();
  let activeJobId: number | null = null;
  let operation: Promise<void> = Promise.resolve();

  const send = (message: HorseLeagueComputeResponse): void => {
    if (parentPort) parentPort.postMessage(message);
    else if (process.send) process.send(message);
    else throw new Error('horse league compute runtime lost its parent transport');
  };
  const receive = (listener: (message: HorseLeagueComputeRequest) => void): void => {
    if (parentPort) parentPort.on('message', listener);
    else process.on('message', (message) => listener(message as HorseLeagueComputeRequest));
  };

  const ready = (async () => {
    if (options.hydrateSolverStores !== false) {
      // These are the same bounded, collect-then-swap loaders used by the live
      // process.  They run here so worker decisions never silently fall back
      // to an empty solver store while the live brain has a hydrated one.
      await Promise.all([loadGtoCharts(), loadGtoPostflop(), loadGtoPostflopV31()]);
    }
    send({
      type: 'READY',
      executionNice: getPriority(0),
      solverStores: {
        charts: gtoChartCount(),
        postflop: gtoPostflopCount(),
        postflopV31: gtoPostflopV31Count(),
      },
    });
  })();

  const run = async (message: HorseLeagueComputeRequest): Promise<void> => {
    if (message.type === 'CANCEL') {
      cancelled.add(message.jobId);
      return;
    }
    if (activeJobId !== null) {
      send({
        type: 'ERROR',
        jobId: message.jobId,
        message: `horse league worker already owns job ${activeJobId}`,
      });
      return;
    }

    activeJobId = message.jobId;
    try {
      await ready;
      if (message.type === 'SCORE_SOLVER_AGREEMENT') {
        const result = scoreSolverAgreement(message.maxSpots);
        send({ type: 'AGREEMENT_RESULT', jobId: message.jobId, result });
        return;
      }

      let lastHeartbeatAt = 0;
      const result = await runMatchup(message.matchup, message.pairs, message.runSeed, () => {
        const now = Date.now();
        if (now - lastHeartbeatAt >= 1_000) {
          lastHeartbeatAt = now;
          send({ type: 'HEARTBEAT', jobId: message.jobId });
        }
        return !cancelled.has(message.jobId);
      });
      send({ type: 'MATCHUP_RESULT', jobId: message.jobId, result });
    } catch (error) {
      send({
        type: 'ERROR',
        jobId: message.jobId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cancelled.delete(message.jobId);
      activeJobId = null;
    }
  };

  receive((message: HorseLeagueComputeRequest) => {
    if (message.type === 'CANCEL') {
      cancelled.add(message.jobId);
      return;
    }
    // There is one CPU lane per worker. Queueing here rather than allowing two
    // jobs to interleave preserves the league's exact seeded decision order.
    operation = operation
      .then(() => run(message))
      .catch((error) => {
        send({
          type: 'ERROR',
          jobId: 'jobId' in message ? message.jobId : null,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });

  ready.catch((error) => {
    send({
      type: 'ERROR',
      jobId: null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
