import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneAdaptiveJournal } from './HorseAdaptiveJournalRetention.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), reply: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockReturnValue({ abortSignal: mocks.reply });
  mocks.reply.mockResolvedValue({
    data: { version: 1, status: 'pruned', completedWork: 100, batches: 100, observations: 1000 },
    error: null,
  });
});
describe('bounded journal retention receipt', () => {
  it('accepts only one bounded pass without claiming completeness', async () => {
    expect(await pruneAdaptiveJournal()).toEqual({
      status: 'pruned',
      completedWork: 100,
      batches: 100,
      observations: 1000,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_prune_horse_adaptive_journal');
    expect(mocks.reply.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });
  it.each([
    { completedWork: 101 },
    { batches: 101 },
    { observations: 1001 },
    { observations: -1 },
    { batches: 0.5 },
    { completedWork: '1' },
    { status: 'done' },
    { version: 2 },
    { observations: undefined },
  ])('does not trust a malformed committed reply: %j', async (change) => {
    mocks.reply.mockResolvedValue({
      data: {
        version: 1,
        status: 'pruned',
        completedWork: 0,
        batches: 0,
        observations: 0,
        ...change,
      },
      error: null,
    });
    expect(await pruneAdaptiveJournal()).toEqual({ status: 'unknown' });
  });
  it('preserves non-waiting capacity contention without a retry loop', async () => {
    mocks.reply.mockResolvedValue({
      data: { version: 1, status: 'unavailable', reason: 'capacity_busy' },
      error: null,
    });
    expect(await pruneAdaptiveJournal()).toEqual({
      status: 'unavailable',
      reason: 'capacity_busy',
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['error', 'throw'])('keeps a lost committed reply unknown: %s', async (mode) => {
    if (mode === 'error')
      mocks.reply.mockResolvedValue({ data: null, error: new Error('lost reply') });
    else mocks.reply.mockRejectedValue(new Error('lost reply'));
    expect(await pruneAdaptiveJournal()).toEqual({ status: 'unknown' });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
