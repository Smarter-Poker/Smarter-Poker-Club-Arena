import { describe, it, expect, vi } from 'vitest';
import { runJournalLoop } from './loop.js';
import { emptyCommittedPotAudit } from './commitmentReceipt.js';
describe('daily committed-pot audit isolated caller', () => {
  it('runs bounded audit turns while journal and model work continue', async () => {
    const stop = new AbortController();
    let now = 0,
      cycles = 0;
    const completed = vi.fn();
    const work = vi.fn(async () => ({ status: 'completed' as const, batchKey: 'a'.repeat(64) }));
    const process = vi.fn(async () => ({
      ...emptyCommittedPotAudit('recorded'),
      scannedHands: 256,
    }));
    const model = vi.fn(async () => 'recorded' as const);
    await runJournalLoop(stop.signal, {
      processWork: work,
      processCommitments: process,
      processModels: model,
      prune: async () => ({ status: 'pruned', completedWork: 0, batches: 0, observations: 0 }),
      now: () => now,
      started: vi.fn(),
      completed,
      wait: async (ms) => {
        now += ms;
        if (++cycles === 20) stop.abort();
      },
    });
    expect(process.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(model).toHaveBeenCalled();
    expect(work.mock.calls.length).toBeGreaterThanOrEqual(12);
    for (const [r] of completed.mock.calls)
      if (r.commitment) expect(r).toMatchObject({ work: 'skipped', retention: 'skipped' });
  });
  it('backs off a failing audit without blocking ordinary work', async () => {
    const stop = new AbortController();
    let now = 0,
      cycles = 0;
    const completed = vi.fn();
    const process = vi.fn(async () => {
      throw Error('lost');
    });
    const work = vi.fn(async () => ({ status: 'completed' as const, batchKey: 'a'.repeat(64) }));
    await runJournalLoop(stop.signal, {
      processWork: work,
      processCommitments: process,
      prune: async () => ({ status: 'pruned', completedWork: 0, batches: 0, observations: 0 }),
      now: () => now,
      started: vi.fn(),
      completed,
      wait: async (ms) => {
        now += ms;
        if (++cycles === 20) stop.abort();
      },
    });
    expect(process).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(19);
    expect(completed.mock.calls.find(([r]) => r.commitment)?.[0].commitment.status).toBe('unknown');
  });
  it('discards an interrupted completion while the durable database cursor remains the retry owner', async () => {
    const stop = new AbortController();
    let now = 0;
    const completed = vi.fn();
    await runJournalLoop(stop.signal, {
      processWork: async () => ({ status: 'completed', batchKey: 'a'.repeat(64) }),
      processCommitments: async () => {
        stop.abort();
        return { ...emptyCommittedPotAudit('recorded'), scannedHands: 256 };
      },
      prune: async () => ({ status: 'pruned', completedWork: 0, batches: 0, observations: 0 }),
      now: () => now,
      started: vi.fn(),
      completed,
      wait: async (ms) => {
        now += ms;
      },
    });
    expect(completed.mock.calls.every(([r]) => r.commitment === undefined)).toBe(true);
  });
});
