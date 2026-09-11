import { expect, it } from 'vitest';
import {
  withLocalHorseDecisionServices,
  type HorseDecisionLocalServices,
} from './localServices.js';
import type { HorseDecisionWorkerDependencies } from './workerRuntime.js';

it('joins every local stop hook despite synchronous and async failures and refuses a failed-owner restart', async () => {
  const calls: string[] = [];
  let releaseWriter!: () => void;
  const writer = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const services: HorseDecisionLocalServices = {
    startMindPersistence: () => {
      calls.push('start:mind');
    },
    stopMindPersistence: async () => {
      calls.push('stop:mind');
      await writer;
      calls.push('joined:mind');
    },
    startTelemetry: () => {},
    stopTelemetry: async () => {
      calls.push('stop:telemetry');
      throw new Error('telemetry stop failed');
    },
    startGovernor: () => {},
    stopGovernor: () => {
      calls.push('stop:governor');
    },
    startPolicyLoader: () => {},
    stopPolicyLoader: () => {
      calls.push('stop:policy');
    },
    hydrateMindFromDb: async () => null,
    hydrateMind: async () => {},
    loadCharts: async () => {},
    loadPostflop: async () => {},
    loadPostflopV31: async () => {},
    startChartLoader: () => {},
    stopChartLoader: () => {
      calls.push('stop:charts');
      throw new Error('chart stop failed');
    },
    startPostflopLoader: () => {},
    stopPostflopLoader: () => {
      calls.push('stop:postflop');
    },
    startPostflopV31Loader: () => {},
    stopPostflopV31Loader: () => {
      calls.push('stop:v31');
    },
  };
  // This test exercises service ownership only; computation is never invoked.
  const compute = { workerReadiness: () => ({}) } as Omit<
    HorseDecisionWorkerDependencies,
    'startServices' | 'stopServices'
  >;
  const owner = withLocalHorseDecisionServices(compute, services);
  await owner.startServices();
  const stop = owner.stopServices();
  expect(owner.stopServices()).toBe(stop);
  let settled = false;
  void stop.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(calls.slice(1)).toEqual([
    'stop:v31',
    'stop:postflop',
    'stop:charts',
    'stop:policy',
    'stop:governor',
    'stop:telemetry',
    'stop:mind',
  ]);
  releaseWriter();
  await expect(stop).rejects.toMatchObject({
    name: 'AggregateError',
    errors: expect.arrayContaining([
      expect.objectContaining({ message: 'chart stop failed' }),
      expect.objectContaining({ message: 'telemetry stop failed' }),
    ]),
  });
  expect(calls.at(-1)).toBe('joined:mind');
  await expect(owner.startServices()).rejects.toThrow(
    'Failed to stop local horse decision services'
  );
  expect(calls.filter((call) => call === 'start:mind')).toHaveLength(1);
});
