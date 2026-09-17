import { describe, it, expect, vi } from 'vitest';
import { runJournalLoop, type JournalCycle } from './loop.js';
import type { JournaledModelCycle } from '../HorseJournaledOpponentModels.js';
describe('isolated model scheduling', () => {
  it.each(['recorded', 'unknown', 'idle', 'capacity_full', 'disabled'] as const)(
    'keeps journal/capture/discovery progressing when models return %s',
    async (status) => {
      const stop = new AbortController(),
        events: string[] = [],
        cycles: JournalCycle[] = [],
        modelTimes: number[] = [];
      let now = 0;
      await runJournalLoop(stop.signal, {
        processWork: async () => {
          events.push('journal');
          return { status: 'completed', batchKey: 'a'.repeat(64) };
        },
        processCapture: async () => {
          events.push('capture');
          return { status: 'idle' };
        },
        discover: async () => {
          events.push('discovery');
          return { status: 'idle', retainedGaps: 0 };
        },
        processModels: async () => {
          events.push('model');
          modelTimes.push(now);
          return status;
        },
        prune: async () => ({ status: 'pruned', completedWork: 0, batches: 0, observations: 0 }),
        now: () => now,
        started: vi.fn(),
        completed: (c) => cycles.push(c),
        wait: async (ms) => {
          expect(ms).toBeLessThanOrEqual(60000);
          now += ms;
          if (events.length >= 200) stop.abort();
        },
      });
      expect(events.indexOf('model')).toBeGreaterThan(8);
      expect(events.filter((e) => e === 'journal').length).toBeGreaterThan(120);
      expect(events.filter((e) => e === 'capture').length).toBeGreaterThan(10);
      expect(events.filter((e) => e === 'discovery').length).toBeGreaterThan(1);
      expect(modelTimes.length).toBeGreaterThan(1);
      if (status !== 'recorded')
        for (let i = 1; i < modelTimes.length; i++)
          expect(modelTimes[i] - modelTimes[i - 1]).toBeGreaterThanOrEqual(60000);
      expect(cycles.filter((c) => c.model)).toEqual(
        modelTimes.map(() => ({ work: 'skipped', retention: 'skipped', model: status }))
      );
    }
  );
  it.each([false, true])(
    'does not publish a model cycle after stop and handles a rejected job (stop=%s)',
    async (abort) => {
      const stop = new AbortController(),
        completed = vi.fn();
      let models = 0;
      await runJournalLoop(stop.signal, {
        processWork: async () => ({ status: 'idle' }),
        processModels: async (): Promise<JournaledModelCycle> => {
          models++;
          if (abort) stop.abort();
          throw Error('failure');
        },
        prune: async () => ({ status: 'pruned', completedWork: 0, batches: 0, observations: 0 }),
        now: () => 0,
        started: vi.fn(),
        completed,
        wait: async () => {
          if (models) stop.abort();
        },
      });
      expect(models).toBe(1);
      expect(completed.mock.calls.filter(([c]) => c.model)).toEqual(
        abort ? [] : [[{ work: 'skipped', retention: 'skipped', model: 'unknown' }]]
      );
    }
  );
});
