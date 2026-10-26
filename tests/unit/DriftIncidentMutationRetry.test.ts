import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { DriftIncidentService } from '../../src/services/DriftIncidentService';

beforeEach(() => {
  rpc.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('incident mutation response loss', () => {
  it('does not repeat a possibly committed action after a network timeout', async () => {
    const lostResponse = new Error('network timeout after commit');
    rpc
      .mockRejectedValueOnce(lostResponse)
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    const result = DriftIncidentService.comment(
      '11111111-1111-4111-8111-111111111111',
      'Evidence reviewed'
    ).catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBe(lostResponse);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('still retries a transient failure of an authoritative read', async () => {
    rpc
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({ data: [], error: null });
    const result = DriftIncidentService.getDashboard('open', 10);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
