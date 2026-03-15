/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — retryFetch
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { retryFetch } from '../../src/utils/retryFetch';

describe('retryFetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return data on first success', async () => {
    const fn = vi.fn().mockResolvedValue({ data: 42, error: null });
    const result = await retryFetch(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: new Error('fail') })
      .mockResolvedValueOnce({ data: 'ok', error: null });
    const result = await retryFetch(fn, 3);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should return null after all retries exhausted', async () => {
    const fn = vi.fn().mockResolvedValue({ data: null, error: new Error('fail') });
    const result = await retryFetch(fn, 2);
    expect(result).toBeNull();
  });

  it('should accept custom retry count', async () => {
    const fn = vi.fn().mockResolvedValue({ data: null, error: new Error('fail') });
    await retryFetch(fn, 1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
