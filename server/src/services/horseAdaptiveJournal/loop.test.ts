import { describe, expect, it, vi } from 'vitest';
import { runJournalLoop } from './loop.js';
import type { AdaptiveJournalWorkResult } from '../HorseAdaptiveJournalWork.js';
const empty = () => ({ status: 'pruned' as const, completedWork: 0, batches: 0, observations: 0 });
describe('isolated journal serial loop', () => {
  it('samples queue health at most once a minute and stops before a later health read', async () => {
    const ctl = new AbortController();
    let now = 0,
      cycles = 0;
    const sampled: number[] = [];
    const readQueueHealth = vi.fn(async () => {
      sampled.push(now);
      return { status: 'unknown' as const };
    });
    const queueHealth = vi.fn();
    await runJournalLoop(ctl.signal, {
      processWork: async () => ({ status: 'idle' }),
      prune: async () => empty(),
      now: () => now,
      started: vi.fn(),
      completed: vi.fn(),
      readQueueHealth,
      queueHealth,
      wait: async (ms) => {
        now += ms;
        if (++cycles === 14) ctl.abort();
      },
    });
    expect(sampled).toEqual([0, 60000]);
    expect(queueHealth).toHaveBeenCalledTimes(2);
  });
  it('does not claim again or prune while work is in flight; stopping starts no later operation', async () => {
    const ctl = new AbortController();
    let release!: (r: AdaptiveJournalWorkResult) => void;
    const processWork = vi.fn(
      () =>
        new Promise<AdaptiveJournalWorkResult>((resolve) => {
          release = resolve;
        })
    );
    const prune = vi.fn(async () => empty());
    const completed = vi.fn();
    const task = runJournalLoop(ctl.signal, {
      processWork,
      prune,
      completed,
      started: vi.fn(),
      now: () => 0,
      wait: vi.fn(),
    });
    await Promise.resolve();
    expect(processWork).toHaveBeenCalledTimes(1);
    expect(prune).not.toHaveBeenCalled();
    ctl.abort();
    release({ status: 'completed', batchKey: 'a'.repeat(64) });
    await task;
    expect(prune).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(processWork).toHaveBeenCalledTimes(1);
  });
  it('backs off unavailable work to60s and resets after healthy work', async () => {
    const ctl = new AbortController();
    const delays: number[] = [];
    let n = 0,
      now = 0;
    await runJournalLoop(ctl.signal, {
      processWork: async () =>
        ++n <= 7 ? { status: 'unavailable', reason: 'failed' } : { status: 'idle' },
      prune: async () => empty(),
      now: () => now,
      started: vi.fn(),
      completed: vi.fn(),
      wait: async (ms) => {
        delays.push(ms);
        now += ms;
        if (delays.length === 8) ctl.abort();
      },
    });
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 5000]);
  });
  it('runs at most one prune per cycle and revisits a capped pass sooner without calling it complete', async () => {
    const ctl = new AbortController();
    let now = 0,
      cycles = 0;
    const prunedAt: number[] = [];
    const completed = vi.fn();
    await runJournalLoop(ctl.signal, {
      processWork: async () => ({ status: 'completed', batchKey: 'a'.repeat(64) }),
      prune: async () => {
        prunedAt.push(now);
        return { status: 'pruned', completedWork: 100, batches: 0, observations: 0 };
      },
      now: () => now,
      started: vi.fn(),
      completed,
      wait: async (ms) => {
        now += ms;
        if (++cycles === 7) ctl.abort();
      },
    });
    expect(prunedAt).toEqual([0, 5000]);
    expect(completed).toHaveBeenCalledTimes(7);
    expect(completed.mock.calls[1][0]).toEqual({ work: 'completed', retention: 'skipped' });
  });
  it('keeps thrown work/prune failures bounded and unknown', async () => {
    const ctl = new AbortController();
    const completed = vi.fn();
    await runJournalLoop(ctl.signal, {
      processWork: async () => {
        throw Error('lost');
      },
      prune: async () => {
        throw Error('lost');
      },
      now: () => 0,
      started: vi.fn(),
      completed,
      wait: async () => {
        ctl.abort();
      },
    });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith({ work: 'unavailable', retention: 'unknown' });
  });
  it('does not start after an already cancelled owner', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const processWork = vi.fn();
    await runJournalLoop(ctl.signal, {
      processWork,
      prune: async () => empty(),
      now: () => 0,
      started: vi.fn(),
      completed: vi.fn(),
      wait: vi.fn(),
    });
    expect(processWork).not.toHaveBeenCalled();
  });
});
