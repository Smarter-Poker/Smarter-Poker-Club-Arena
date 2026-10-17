/**
 * THE DECISION WORKER RUNS THE QUALIFIED BRAIN, AND KNOWS ITS OWN HANDS
 * (2026-10-16). client.ts spawns every decision worker with
 * EQUITY_GOVERNOR=off and its shard count; workerRuntime.ts refuses readiness
 * with a governed worker and only learns (never journals) another shard's
 * completed hand.
 */
import { describe, expect, it } from 'vitest';

import { horseDecisionWorkerEnv } from './client.js';
import { horseDecisionShard } from './shard.js';
import { completedHandOwnership, shardCountFromWorkerData, shardFromWorkerData } from './worker.js';
import { assertDecisionWorkerRunsFullSample } from './workerRuntime.js';

describe('the decision worker decides at the full sample', () => {
  it('is spawned with its governor off, whatever the parent environment says', () => {
    expect(horseDecisionWorkerEnv({ EQUITY_GOVERNOR: 'on', PATH: '/bin' })).toEqual({
      EQUITY_GOVERNOR: 'off',
      PATH: '/bin',
    });
    expect(horseDecisionWorkerEnv({}).EQUITY_GOVERNOR).toBe('off');
  });

  it('refuses readiness when its governor could still cut the sample', () => {
    const governor = (enabled: boolean, scale: number) => ({
      snapshot: () => ({ enabled }),
      current: () => scale,
    });
    expect(() => assertDecisionWorkerRunsFullSample(governor(false, 1))).not.toThrow();
    expect(() => assertDecisionWorkerRunsFullSample(governor(true, 1))).toThrow(
      /EQUITY_GOVERNOR=off/
    );
    expect(() => assertDecisionWorkerRunsFullSample(governor(false, 0.6))).toThrow(
      /qualified Monte Carlo sample/
    );
  });
});

describe("a worker tells its own completed hands from another shard's", () => {
  const fence = (table: string) => `${table}:1000001:9:observe`;
  const tables = Array.from(
    { length: 30 },
    (_, i) => `10000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
  );

  it('owns exactly the hands the lane routes to it', () => {
    for (let index = 0; index < 3; index++) {
      const owns = completedHandOwnership({ index }, 3)!;
      for (const table of tables)
        expect(owns({ fence: fence(table) })).toBe(horseDecisionShard(fence(table), 3) === index);
    }
  });

  it('owns every hand when it is the only worker or the count is unknown', () => {
    expect(completedHandOwnership({ index: 0 }, 1)).toBeUndefined();
    expect(completedHandOwnership({ index: 0 }, undefined)).toBeUndefined();
    expect(completedHandOwnership(undefined, 3)).toBeUndefined();
    expect(completedHandOwnership({ index: 3 }, 3)).toBeUndefined();
  });

  it('reads index and count from workerData, refusing malformed values', () => {
    expect(shardFromWorkerData({ shardIndex: 2, shardCount: 3 })).toEqual({ index: 2 });
    expect(shardCountFromWorkerData({ shardIndex: 2, shardCount: 3 })).toBe(3);
    for (const bad of [
      undefined,
      null,
      {},
      { shardCount: 0 },
      { shardCount: 1.5 },
      { shardCount: '3' },
    ])
      expect(shardCountFromWorkerData(bad)).toBeUndefined();
  });
});
