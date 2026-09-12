import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/HorseMindPersistence.js', () => ({
  hydrateHorseMindFromDb: vi.fn(async () => null),
  startHorseMindPersistence: vi.fn(),
  stopHorseMindPersistence: vi.fn(async () => {}),
}));
vi.mock('../../services/HorseMindHydrator.js', () => ({ hydrateHorseMind: vi.fn(async () => {}) }));
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
import { equityGovernor } from '../EquityLoadGovernor.js';
import {
  hydrateHorseMindFromDb,
  stopHorseMindPersistence,
} from '../../services/HorseMindPersistence.js';
import { loadGtoCharts } from '../../services/GtoChartLoader.js';

afterEach(async () => {
  await worker.stopServices();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('real worker-owned startup preparation', () => {
  it('finishes hydration and fixed card preparation before readiness, once per startup', async () => {
    vi.spyOn(equityGovernor, 'startSampling').mockImplementation(() => {});
    vi.spyOn(equityGovernor, 'stopSampling').mockImplementation(() => {});
    let hydrated = false,
      prepared = false,
      ready = false;
    let release!: () => void;
    vi.mocked(loadGtoCharts).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            hydrated = true;
            resolve();
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
