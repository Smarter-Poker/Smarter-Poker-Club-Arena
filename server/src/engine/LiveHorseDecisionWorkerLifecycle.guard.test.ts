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
  /**
   * 2026-10-24: the lane no longer finishes BEFORE the stale-data cleanup; it
   * starts before it and is joined after it, so hydration and cleanup overlap
   * (engine boot time, docs/changelog/2026-10-24-the-engine-boot-overlaps-its-lanes.md).
   * The invariant this pin protects is unchanged and asserted on what it
   * actually means: leadership is decided first, no table can be admitted
   * before the worker is READY (the join precedes break adoption, every
   * discovery loop and the dealer gate), and a lane failure is still fatal.
   */
  it('starts the sole worker only after leadership and joins it before any table can be admitted', () => {
    const start = sliceMethod(gameServerSource, 'private async performStart(');
    const code = blankNonCode(start);
    const finalStandbyBranch = start.lastIndexOf("if (role === 'standby')");
    const standbyReturn = code.indexOf('return;', finalStandbyBranch);
    const workerStart = code.indexOf('const horseLane = startLiveHorseDecisionWorker(');
    const cleanup = code.indexOf('this.cleanupStaleData(');
    const join = code.indexOf('const [horseOutcome, equityOutcome] = await lanesSettled;');
    const breakAdoption = code.indexOf('this.maintenanceBreak.start()');
    const discovery = code.indexOf('this.discoverCashTables()');
    const dealerReady = code.indexOf('this.publishDealerPrerequisitesReady(generation)');
    const bootComplete = code.indexOf('this.leaderBootComplete = true');

    expect(finalStandbyBranch).toBeGreaterThan(-1);
    expect(standbyReturn).toBeGreaterThan(finalStandbyBranch);
    expect(workerStart).toBeGreaterThan(standbyReturn);
    expect(cleanup).toBeGreaterThan(workerStart);
    expect(join).toBeGreaterThan(cleanup);
    expect(breakAdoption).toBeGreaterThan(join);
    expect(discovery).toBeGreaterThan(join);
    expect(dealerReady).toBeGreaterThan(join);
    expect(bootComplete).toBeGreaterThan(dealerReady);
    // The lane promise is observed at admission (no unhandled rejection while
    // the cleanup is awaited) and its verdict is read right after the join.
    expect(code.slice(workerStart, cleanup)).toContain('onFatal: (error) =>');
    expect(code.slice(workerStart, cleanup)).toContain('throw error;');
    expect(code.slice(workerStart, cleanup)).toContain('Promise.allSettled([');
    const verdict = code.slice(join, breakAdoption);
    expect(verdict).toContain('if (horseOutcome.status === ');
    expect(verdict).toContain('const error = horseOutcome.reason;');
    expect(verdict).toContain('error instanceof HorseDecisionAbortedError &&');
    expect(verdict).toContain('if (!this.directAdmissionIsCurrent(generation)) return;');
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
