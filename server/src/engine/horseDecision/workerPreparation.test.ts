import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/HorseOpponentMemory.js', () => ({
  horseOpponentMemorySchema: vi.fn(async () => 'installed'),
}));

vi.mock('../../services/HorseMindPersistence.js', () => ({
  hydrateHorseMindFromDb: vi.fn(async () => null),
  startHorseMindPersistence: vi.fn(),
  stopHorseMindPersistence: vi.fn(async () => {}),
}));
vi.mock('../../services/HorseMindHydrator.js', () => ({ hydrateHorseMind: vi.fn(async () => {}) }));
vi.mock('../../services/HorseExploitHydrator.js', () => ({
  hydrateHorseExploitReads: vi.fn(async () => ({ hands: 0, rows: 0 })),
}));
vi.mock('../../services/BrainTelemetryFlush.js', () => ({
  startBrainTelemetryFlush: vi.fn(),
  stopBrainTelemetryFlush: vi.fn(async () => {}),
}));
vi.mock('../../services/GtoChartLoader.js', () => ({
  loadGtoCharts: vi.fn(async () => {}),
  startGtoChartLoader: vi.fn(),
  stopGtoChartLoader: vi.fn(),
}));
vi.mock('../../services/GtoPostflopLoader.js', () => ({
  loadGtoPostflop: vi.fn(async () => {}),
  startGtoPostflopLoader: vi.fn(),
  stopGtoPostflopLoader: vi.fn(),
}));
vi.mock('../../services/GtoPostflopV31Loader.js', () => ({
  loadGtoPostflopV31: vi.fn(async () => {}),
  startGtoPostflopV31Loader: vi.fn(),
  stopGtoPostflopV31Loader: vi.fn(),
}));
vi.mock('../../gto/SolverPolicyArtifactLoader.js', () => ({
  solverPolicyArtifactStatus: vi.fn(() => ({})),
  startSolverPolicyArtifactLoader: vi.fn(),
  stopSolverPolicyArtifactLoader: vi.fn(),
}));

import { defaultHorseDecisionWorkerDependencies as worker } from './workerRuntime.js';
import * as future from '../HorseTournamentFutureHand.js';
import { horseOpponentMemorySchema } from '../../services/HorseOpponentMemory.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import {
  hydrateHorseMindFromDb,
  stopHorseMindPersistence,
} from '../../services/HorseMindPersistence.js';
import { loadGtoCharts } from '../../services/GtoChartLoader.js';
import { loadGtoPostflop } from '../../services/GtoPostflopLoader.js';
import { loadGtoPostflopV31 } from '../../services/GtoPostflopV31Loader.js';
import { hydrateHorseMind } from '../../services/HorseMindHydrator.js';
import { hydrateHorseExploitReads } from '../../services/HorseExploitHydrator.js';
import { gtoChartStoreIdentity } from '../GtoCharts.js';
import { gtoPostflopStoreIdentity } from '../GtoPostflop.js';

afterEach(async () => {
  await worker.stopServices();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('real worker-owned startup preparation', () => {
  it('keeps an unrelated engine release compatible before the declared schema window', async () => {
    vi.mocked(horseOpponentMemorySchema).mockResolvedValueOnce('unavailable');
    await expect(worker.startServices()).resolves.toBeDefined();
    expect(horseOpponentMemorySchema).toHaveBeenCalledTimes(1);
  });

  it('finishes hydration and fixed card preparation before readiness, once per startup', async () => {
    vi.spyOn(equityGovernor, 'startSampling').mockImplementation(() => {});
    vi.spyOn(equityGovernor, 'stopSampling').mockImplementation(() => {});
    let hydrated = false,
      prepared = false,
      ready = false;
    let release!: () => void;
    vi.mocked(loadGtoCharts).mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          release = () => {
            hydrated = true;
            resolve(0);
          };
        })
    );
    const prepare = vi.spyOn(future, 'prepareTournamentFutureHandFacts').mockImplementation(() => {
      expect(hydrated).toBe(true);
      expect(ready).toBe(false);
      prepared = true;
    });
    const startup = worker.startServices().then(() => {
      expect(prepared).toBe(true);
      ready = true;
    });
    await vi.waitFor(() => expect(loadGtoCharts).toHaveBeenCalled());
    expect(prepare).not.toHaveBeenCalled();
    expect(ready).toBe(false);
    release();
    await startup;
    await worker.startServices();
    expect(hydrateHorseMindFromDb).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('starts the solver and exploit loads beside the durable mind read, and replays only after it', async () => {
    vi.spyOn(equityGovernor, 'startSampling').mockImplementation(() => {});
    vi.spyOn(equityGovernor, 'stopSampling').mockImplementation(() => {});
    vi.spyOn(future, 'prepareTournamentFutureHandFacts').mockImplementation(() => {});
    let releaseMind!: (lastFlush: string | null) => void;
    vi.mocked(hydrateHorseMindFromDb).mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseMind = resolve;
        })
    );
    let ready = false;
    const startup = worker.startServices().then(() => {
      ready = true;
    });
    // Every independent load has begun while the mind read is still pending.
    await vi.waitFor(() => {
      expect(hydrateHorseMindFromDb).toHaveBeenCalledTimes(1);
      expect(loadGtoCharts).toHaveBeenCalledTimes(1);
      expect(loadGtoPostflop).toHaveBeenCalledTimes(1);
      expect(loadGtoPostflopV31).toHaveBeenCalledTimes(1);
      expect(hydrateHorseExploitReads).toHaveBeenCalledTimes(1);
    });
    // The replay needs the flush mark, so it has not started, and READY waits.
    expect(hydrateHorseMind).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(ready).toBe(false);
    releaseMind('2026-10-24T08:00:00.000Z');
    await startup;
    expect(hydrateHorseMind).toHaveBeenCalledWith('2026-10-24T08:00:00.000Z');
    expect(ready).toBe(true);
  });

  it('reports the content identity of the stores it decides with, at READY and beside every decision', async () => {
    vi.spyOn(equityGovernor, 'startSampling').mockImplementation(() => {});
    vi.spyOn(equityGovernor, 'stopSampling').mockImplementation(() => {});
    vi.spyOn(future, 'prepareTournamentFutureHandFacts').mockImplementation(() => {});
    const readiness = await worker.startServices();
    const expected = { charts: gtoChartStoreIdentity(), postflop: gtoPostflopStoreIdentity() };
    expect(readiness.solverStoreIdentity).toEqual(expected);
    expect(worker.workerReadiness().solverStoreIdentity).toEqual(expected);
    expect(expected.charts.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('joins outstanding boot reads before draining after a parallel load fails', async () => {
    vi.spyOn(equityGovernor, 'startSampling').mockImplementation(() => {});
    vi.spyOn(equityGovernor, 'stopSampling').mockImplementation(() => {});
    const prepare = vi.spyOn(future, 'prepareTournamentFutureHandFacts');
    let releaseMind!: () => void;
    vi.mocked(hydrateHorseMindFromDb).mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          releaseMind = () => resolve(null);
        })
    );
    const failure = new Error('chart load failed');
    vi.mocked(loadGtoCharts).mockRejectedValueOnce(failure);
    let finished = false;
    const startup = worker.startServices().then(
      () => {
        throw new Error('failed boot reported ready');
      },
      (error) => {
        finished = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(loadGtoCharts).toHaveBeenCalled());
    try {
      expect(finished).toBe(false);
      expect(stopHorseMindPersistence).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      releaseMind();
      expect(await startup).toBe(failure);
    }
    expect(hydrateHorseMind).toHaveBeenCalledTimes(1);
    expect(stopHorseMindPersistence).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects readiness and drains owned services if preparation fails', async () => {
    vi.spyOn(equityGovernor, 'startSampling').mockImplementation(() => {});
    vi.spyOn(equityGovernor, 'stopSampling').mockImplementation(() => {});
    vi.spyOn(future, 'prepareTournamentFutureHandFacts').mockImplementation(() => {
      throw new Error('preparation failed');
    });
    await expect(worker.startServices()).rejects.toThrow('preparation failed');
    expect(stopHorseMindPersistence).toHaveBeenCalledTimes(1);
  });
});
