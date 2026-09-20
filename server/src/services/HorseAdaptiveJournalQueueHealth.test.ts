import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJournalQueueHealth } from './HorseAdaptiveJournalQueueHealth.js';
const m = vi.hoisted(() => ({ rpc: vi.fn(), reply: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockReturnValue({ abortSignal: m.reply });
});
describe('journal queue health transport', () => {
  it('makes one bounded read and does not turn a transport failure into zero work', async () => {
    m.reply.mockResolvedValue({ data: null, error: Error('failed') });
    expect(await readJournalQueueHealth()).toEqual({ status: 'unknown' });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('fn_horse_adaptive_journal_work_health');
    expect(m.reply.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });
  it('catches a lost response without a retry loop', async () => {
    m.reply.mockRejectedValue(Error('lost'));
    expect(await readJournalQueueHealth()).toEqual({ status: 'unknown' });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
});
