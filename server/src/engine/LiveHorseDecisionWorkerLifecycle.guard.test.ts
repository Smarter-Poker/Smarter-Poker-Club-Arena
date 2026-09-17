import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const gameServerSource = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const workerSource = readFileSync(
  new URL('./horseDecision/workerRuntime.ts', import.meta.url),
  'utf8'
);

describe('live HorseLogic has one lifecycle owner', () => {
  it('starts the sole worker only after leadership and before cleanup can admit a table', () => {
    const start = sliceMethod(gameServerSource, 'private async performStart(');
    const code = blankNonCode(start);
    const finalStandbyBranch = start.lastIndexOf("if (role === 'standby')");
    const standbyReturn = code.indexOf('return;', finalStandbyBranch);
    const workerStart = code.indexOf('await startLiveHorseDecisionWorker(');
    const cleanup = code.indexOf('await this.cleanupStaleData(');
    const dealerReady = code.indexOf('this.publishDealerPrerequisitesReady(generation)');
    const bootComplete = code.indexOf('this.leaderBootComplete = true');

    expect(finalStandbyBranch).toBeGreaterThan(-1);
    expect(standbyReturn).toBeGreaterThan(finalStandbyBranch);
    expect(workerStart).toBeGreaterThan(standbyReturn);
    expect(cleanup).toBeGreaterThan(workerStart);
    expect(dealerReady).toBeGreaterThan(cleanup);
    expect(bootComplete).toBeGreaterThan(dealerReady);
    expect(code.slice(workerStart, cleanup)).toContain('onFatal: (error) =>');
    expect(code.slice(workerStart, cleanup)).toContain('throw error;');
    expect(code.slice(workerStart, cleanup)).toContain(
      'error instanceof HorseDecisionAbortedError &&'
    );
    expect(code.slice(workerStart, cleanup)).toContain(
      'if (!this.directAdmissionIsCurrent(generation)) return;'
    );
  });

  it('drains the worker after every dealer and before distributed release', () => {
    const stop = blankNonCode(sliceMethod(gameServerSource, 'private async performStop('));
    const dealerJoin = stop.indexOf(
      'const [engineStopResults, managerStopResults] = await Promise.all('
    );
    const workerStop = stop.indexOf('stopLiveHorseDecisionWorker', dealerJoin);
    const executionFlush = stop.indexOf('stopBrainTelemetryFlush', dealerJoin);
    const ownershipFailure = stop.indexOf('ownershipFailures.push(error)', workerStop);
    const ownershipGate = stop.indexOf('if (ownershipFailures.length > 0)', workerStop);
    const cashRelease = stop.indexOf('await releaseTables(cashLeaseClaims)', workerStop);

    expect(dealerJoin).toBeGreaterThan(-1);
    expect(workerStop).toBeGreaterThan(dealerJoin);
    expect(executionFlush).toBeGreaterThan(dealerJoin);
    expect(executionFlush).toBeLessThan(ownershipGate);
    expect(stop.slice(executionFlush, ownershipGate)).toContain(
      'horseExecutionTelemetryStop.status'
    );
    expect(ownershipFailure).toBeGreaterThan(workerStop);
    expect(ownershipGate).toBeGreaterThan(ownershipFailure);
    expect(cashRelease).toBeGreaterThan(ownershipGate);
  });

  it('cancels a worker still hydrating before joining boot', () => {
    const stop = blankNonCode(sliceMethod(gameServerSource, 'private async performStop('));
    const startupCancellation = stop.indexOf('const startingHorseDecisionStop =');
    const bootJoin = stop.indexOf('await this.startOperation.catch(');
    const dealerJoin = stop.indexOf(
      'const [engineStopResults, managerStopResults] = await Promise.all('
    );
    const finalWorkerJoin = stop.indexOf('startingHorseDecisionStop ??', dealerJoin);

    expect(startupCancellation).toBeGreaterThan(-1);
    expect(startupCancellation).toBeLessThan(bootJoin);
    expect(finalWorkerJoin).toBeGreaterThan(dealerJoin);
  });

  it('publishes worker phase, queue and worker-owned solver health', () => {
    const health = sliceMethod(gameServerSource, '\n  getStatus(');
    expect(health).toContain('const liveHorseDecision = liveHorseDecisionWorkerStatus()');
    expect(health).toContain('equityGovernor: liveHorseDecision.governor');
    expect(health).toContain('mainEventLoopGovernor: equityGovernor.snapshot()');
    expect(health).toContain('liveHorseDecision,');
    expect(health).toContain('dealerPrerequisitesReady: this.dealerPrerequisitesReady');
    expect(health).toContain('solverPolicyArtifact: liveHorseDecision.solverPolicyArtifact');
    expect(health).toContain("liveHorseDecision.phase === 'ready'");
    expect(gameServerSource).not.toContain('solverPolicyArtifactStatus()');
  });

  it('keeps HorseMind and live solver stores out of the main-thread bootstrap', () => {
    for (const mainThreadOwner of [
      'hydrateHorseMindFromDb',
      'startHorseMindPersistence',
      'startSolverPolicyArtifactLoader',
      'startGtoChartLoader',
      'startGtoPostflopLoader',
      'startGtoPostflopV31Loader',
    ]) {
      expect(indexSource).not.toContain(mainThreadOwner);
      expect(workerSource).toContain(mainThreadOwner);
    }

    expect(indexSource).toContain('startBrainTelemetryFlush()');
    expect(indexSource).toContain('startGtoAggregationDriver()');
    expect(indexSource).toContain('startGtoAggregationDriverV31()');
    expect(indexSource).toContain('startHorseLeague()');
  });
});
