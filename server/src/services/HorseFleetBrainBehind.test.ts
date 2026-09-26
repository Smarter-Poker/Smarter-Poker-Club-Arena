/**
 * THE FLEET SEATS NO NEW HORSE WHILE THE DECISION LANE IS BEHIND
 *
 * 2026-09-26, measured on engine-01: the fleet re-expanded to 780-880 dealing
 * tables and the one-thread horse decision lane could not think for them.
 * Queue depth 566-986, the oldest queued decision 7.4-13.5 s old, 40-68
 * expiries a second, completedJobs 40,221 against expiredJobs 53,652 in 29
 * minutes. An expired decision is a seat taking the legal check or fold
 * without thinking - 57% of every decision. The fleet manager kept seating
 * new horses every 30 s regardless.
 *
 * This runs one real `seedAllTables` cycle against an empty floor with every
 * read stubbed, and checks only what the lane's status does to the beat: a
 * lane 5 s behind lands `brain_behind` on the heartbeat with no seat filled,
 * and a lane 100 ms behind does not. The pure arithmetic is in
 * HorseFleetPolicy.test.ts; the source wiring is in
 * HorseFleetPolicyWiring.test.ts. This is the one that proves the two meet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseFleetManager } from './HorseFleetManager.js';
import { fetchAllRows } from './supabase/pagination.js';
import { liveHorseDecisionWorkerStatus } from '../engine/horseDecision/lane.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { _resetFleetPolicyCacheForTests } from './HorseFleetPolicy.js';

vi.mock('./supabase/pagination.js', async (original) => ({
  ...(await original<typeof import('./supabase/pagination.js')>()),
  fetchAllRows: vi.fn(),
}));

vi.mock('../engine/horseDecision/lane.js', async (original) => ({
  ...(await original<typeof import('../engine/horseDecision/lane.js')>()),
  liveHorseDecisionWorkerStatus: vi.fn(),
}));

/* A query builder that accepts any chain and resolves to an empty, error-free
   result: the floor is empty, so every read the cycle makes finds nothing. */
function emptyClient(): unknown {
  const result = { data: [], error: null, count: 0 };
  const chain: Record<string | symbol, unknown> = {};
  const proxy: unknown = new Proxy(chain, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      }
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock('./supabase/client.js', async (original) => ({
  ...(await original<typeof import('./supabase/client.js')>()),
  supabase: emptyClient(),
  seedingSupabase: emptyClient(),
}));

type Harness = {
  seedAllTables(): Promise<void>;
  publishFleetState(
    beat: { reason: string | null; seatsFilled: number },
    ms: number
  ): Promise<void>;
};

function laneStatus(over: { oldestQueuedAgeMs: number | null; phase: string }) {
  return {
    phase: over.phase,
    queueDepth: 0,
    inFlightJobs: 0,
    completedJobs: 0,
    expiredJobs: 0,
    oldestQueuedAgeMs: over.oldestQueuedAgeMs,
    lastComputeMs: null,
    lastError: null,
    workerCount: 1,
    workers: [],
  } as unknown as ReturnType<typeof liveHorseDecisionWorkerStatus>;
}

async function runOneCycle(status: { oldestQueuedAgeMs: number | null; phase: string }) {
  vi.mocked(liveHorseDecisionWorkerStatus).mockReturnValue(laneStatus(status));
  const fleet = new HorseFleetManager() as unknown as Harness;
  const publish = vi.spyOn(fleet, 'publishFleetState').mockResolvedValue();
  await fleet.seedAllTables();
  expect(publish).toHaveBeenCalledOnce();
  return publish.mock.calls[0][0];
}

describe('a seeding cycle asks the decision lane before it seats anybody', () => {
  beforeEach(() => {
    setMaintenanceFrozen(false);
    _resetFleetPolicyCacheForTests();
    vi.mocked(fetchAllRows).mockResolvedValue({ rows: [], complete: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    setMaintenanceFrozen(false);
  });

  it('a lane 5 s behind: zero seats and the beat says brain_behind', async () => {
    const beat = await runOneCycle({ oldestQueuedAgeMs: 5000, phase: 'ready' });
    expect(beat.reason).toBe('brain_behind');
    expect(beat.seatsFilled).toBe(0);
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      expect.stringContaining('the decision lane is 5000 ms behind (hold at 2000 ms)')
    );
  });

  it('a lane that is not ready: zero seats and the beat says brain_behind', async () => {
    const beat = await runOneCycle({ oldestQueuedAgeMs: null, phase: 'starting' });
    expect(beat.reason).toBe('brain_behind');
    expect(beat.seatsFilled).toBe(0);
  });

  it('a ready lane 100 ms behind is not a hold', async () => {
    const beat = await runOneCycle({ oldestQueuedAgeMs: 100, phase: 'ready' });
    /* The cycle ran to its end: an empty floor has nothing to seat, which is
       the reason the beat has always carried. Not an early exit, not a hold. */
    expect(beat.reason).toBe('nothing_to_seat');
    expect(vi.mocked(console.log)).not.toHaveBeenCalledWith(
      expect.stringContaining('no new seats this cycle')
    );
  });

  it('reads the lane exactly once per cycle', async () => {
    await runOneCycle({ oldestQueuedAgeMs: 5000, phase: 'ready' });
    expect(vi.mocked(liveHorseDecisionWorkerStatus)).toHaveBeenCalledTimes(1);
  });
});
