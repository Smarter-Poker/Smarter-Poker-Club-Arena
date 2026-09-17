import { beforeEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn(), response: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
import { readLearningQueueHealth as read } from './HorseLearningQueueHealth.js';
beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockReturnValue({ abortSignal: m.response });
});
describe('one-budget learning queue health', () => {
  it('reads both independent queue populations within one RPC deadline', async () => {
    const shared = {
      version: 1,
      status: 'snapshot',
      sampledAtMs: Date.now(),
      unfinished: 0,
      queued: 0,
      leased: 0,
      ready: 0,
      expiredLeases: 0,
      oldestWorkAgeMs: 0,
      maxAttempts: 0,
    };
    m.response.mockResolvedValue({
      error: null,
      data: {
        version: 1,
        journal: { ...shared, quarantined: 0, bufferedBytes: 0 },
        capture: { ...shared, gaps: 0 },
      },
    });
    const r = await read();
    expect(r.journal.status).toBe('snapshot');
    expect(r.capture.status).toBe('snapshot');
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('fn_horse_learning_work_health');
    expect(m.response.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });
  it('does not infer an empty source backlog from a missing or failed health response', async () => {
    m.response.mockRejectedValueOnce(Error('lost'));
    expect(await read()).toEqual({
      journal: { status: 'unknown' },
      capture: { status: 'unknown' },
    });
    m.response.mockResolvedValueOnce({ error: null, data: { version: 1 } });
    expect(await read()).toEqual({
      journal: { status: 'unknown' },
      capture: { status: 'unknown' },
    });
  });
});
