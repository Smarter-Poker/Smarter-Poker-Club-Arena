import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../../testHelpers/sourceWindow.js';
import { EquityWorkerPool } from './EquityWorkerPool.js';

const gameServer = readFileSync(new URL('../../GameServer.ts', import.meta.url), 'utf8');
const instruments = readFileSync(
  new URL('../../observability/engineInstruments.ts', import.meta.url),
  'utf8'
);

describe('equity worker capacity is a routing prerequisite', () => {
  it('normalizes configured capacity to a finite integer inside the CPU budget', () => {
    const capacity = Math.max(1, availableParallelism() - 2);
    expect(new EquityWorkerPool({ size: 1.9 }).status().configuredWorkers).toBe(1);
    expect(new EquityWorkerPool({ size: Number.NaN }).status().configuredWorkers).toBe(capacity);
    expect(new EquityWorkerPool({ size: Number.MAX_VALUE }).status().configuredWorkers).toBe(
      capacity
    );
  });

  it('waits for READY before discovery can admit tables', () => {
    const start = blankNonCode(sliceMethod(gameServer, 'private async performStart('));
    const workerStart = start.indexOf('await startEquityWorkerPool()');
    const cleanup = start.indexOf('await this.cleanupStaleData(');
    const dealerReady = start.indexOf('this.publishDealerPrerequisitesReady(generation)');

    expect(workerStart).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(workerStart);
    expect(dealerReady).toBeGreaterThan(cleanup);
    expect(start.slice(workerStart, cleanup)).toContain(
      'error instanceof EquityWorkerPoolAbortedError &&'
    );
  });

  it('joins the pool after dealer drain and before distributed release', () => {
    const stop = blankNonCode(sliceMethod(gameServer, 'private async performStop('));
    const dealerJoin = stop.indexOf(
      'const [engineStopResults, managerStopResults] = await Promise.all('
    );
    const workerStop = stop.indexOf('stopEquityWorkerPool', dealerJoin);
    const ownershipGate = stop.indexOf('if (ownershipFailures.length > 0)', workerStop);
    const cashRelease = stop.indexOf('await releaseTables(cashLeaseClaims)', workerStop);

    expect(workerStop).toBeGreaterThan(dealerJoin);
    expect(ownershipGate).toBeGreaterThan(workerStop);
    expect(cashRelease).toBeGreaterThan(ownershipGate);
  });

  it('publishes queue pressure and refuses healthy routing at partial capacity', () => {
    const health = sliceMethod(gameServer, 'getStatus()');
    const metrics = sliceMethod(gameServer, 'getPrometheusMetrics()');
    expect(health).toContain('equityWorkerPool: equityWorkers');
    expect(health).toContain("equityWorkers.phase === 'ready'");
    expect(metrics).toContain('equityWorkerPoolQueueDepth.set(equityWorkers.queueDepth)');
    expect(metrics).toContain(
      'equityWorkerPoolOldestQueuedAgeMs.set(equityWorkers.oldestQueuedAgeMs)'
    );
    for (const metric of [
      'poker_equity_worker_pool_ready',
      'poker_equity_worker_pool_configured_workers',
      'poker_equity_worker_pool_ready_workers',
      'poker_equity_worker_pool_busy_workers',
      'poker_equity_worker_pool_queue_depth',
      'poker_equity_worker_pool_oldest_queued_age_ms',
      'poker_equity_worker_pool_last_completion_age_ms',
    ]) {
      expect(instruments).toContain(metric);
    }
  });
});
