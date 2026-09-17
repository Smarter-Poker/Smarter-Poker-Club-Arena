import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  port: { postMessage: vi.fn(), on: vi.fn() },
  options: { hydrateSolverStores: true },
  charts: vi.fn(),
  postflop: vi.fn(),
  v31: vi.fn(),
  prepare: vi.fn(),
  matchup: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({
  isMainThread: false,
  parentPort: runtime.port,
  workerData: runtime.options,
}));
vi.mock('./HorseLeague.js', () => ({ runMatchup: runtime.matchup }));
vi.mock('./HorseTournamentLeague.js', () => ({ runTournamentLeague: vi.fn() }));
vi.mock('./HorseSolverAgreement.js', () => ({ scoreSolverAgreement: vi.fn() }));
vi.mock('./HorseSolverAgreementV31.js', () => ({ scoreGtoV31Agreement: vi.fn() }));
vi.mock('../engine/GtoCharts.js', () => ({ gtoChartCount: () => 0 }));
vi.mock('../engine/GtoPostflop.js', () => ({ gtoPostflopCount: () => 0 }));
vi.mock('../engine/GtoPostflopV31.js', () => ({
  gtoPostflopV31Count: () => 0,
  gtoPostflopV31Dataset: () => null,
}));
vi.mock('../services/GtoChartLoader.js', () => ({ loadGtoCharts: runtime.charts }));
vi.mock('../services/GtoPostflopLoader.js', () => ({ loadGtoPostflop: runtime.postflop }));
vi.mock('../services/GtoPostflopV31Loader.js', () => ({ loadGtoPostflopV31: runtime.v31 }));
vi.mock('../engine/HorseTournamentFutureHand.js', () => ({
  prepareTournamentFutureHandFacts: runtime.prepare,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  runtime.options.hydrateSolverStores = true;
  runtime.charts.mockResolvedValue(0);
  runtime.postflop.mockResolvedValue(0);
  runtime.v31.mockResolvedValue(0);
});

describe('league worker owns the same fixed facts as the live decision worker', () => {
  it('prepares in the worker after hydration and before announcing readiness', async () => {
    let release!: () => void;
    runtime.charts.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    runtime.prepare.mockImplementation(() => {
      expect(runtime.port.postMessage).not.toHaveBeenCalled();
    });
    await import('./HorseLeagueComputeWorker.js');
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.port.postMessage).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(runtime.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'READY' })
      )
    );
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
  });

  it('also prepares the isolated fixture worker when solver hydration is explicitly disabled', async () => {
    runtime.options.hydrateSolverStores = false;
    await import('./HorseLeagueComputeWorker.js');
    await vi.waitFor(() =>
      expect(runtime.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'READY' })
      )
    );
    expect(runtime.charts).not.toHaveBeenCalled();
    expect(runtime.postflop).not.toHaveBeenCalled();
    expect(runtime.v31).not.toHaveBeenCalled();
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
  });

  it('refuses readiness and queued computation after preparation fails', async () => {
    runtime.prepare.mockImplementation(() => {
      throw new Error('fixed fact preparation failed');
    });
    await import('./HorseLeagueComputeWorker.js');
    await vi.waitFor(() =>
      expect(runtime.port.postMessage).toHaveBeenCalledWith({
        type: 'ERROR',
        jobId: null,
        message: 'fixed fact preparation failed',
      })
    );
    const receive = runtime.port.on.mock.calls.find(([event]) => event === 'message')![1];
    receive({
      type: 'RUN_MATCHUP',
      jobId: 7,
      matchup: { name: 'fixture', a: {}, b: {} },
      pairs: 1,
      runSeed: 1,
    });
    await vi.waitFor(() =>
      expect(runtime.port.postMessage).toHaveBeenCalledWith({
        type: 'ERROR',
        jobId: 7,
        message: 'fixed fact preparation failed',
      })
    );
    expect(runtime.matchup).not.toHaveBeenCalled();
    expect(runtime.port.postMessage.mock.calls.some(([message]) => message.type === 'READY')).toBe(
      false
    );
  });
});
