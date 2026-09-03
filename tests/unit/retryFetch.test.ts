/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — retryFetch
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { retryFetch } from '../../src/utils/retryFetch';

describe('retryFetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return data on first success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retryFetch(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure then succeed', async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      if (calls === 1) throw new Error('fail');
      return Promise.resolve('ok');
    });
    const result = await retryFetch(fn, { maxRetries: 2, baseDelayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw after all retries exhausted', async () => {
    const fn = vi.fn(() => {
      throw new Error('always-fail');
    });
    await expect(retryFetch(fn, { maxRetries: 1, baseDelayMs: 0 })).rejects.toThrow();
  });

  it('should be a function export', () => {
    expect(typeof retryFetch).toBe('function');
  });

  it('should return null if function resolves with null', async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const result = await retryFetch(fn);
    expect(result).toBeNull();
  });

  it('should return 0 if function resolves with 0', async () => {
    const fn = vi.fn().mockResolvedValue(0);
    const result = await retryFetch(fn);
    expect(result).toBe(0);
  });

  it('should return false if function resolves with false', async () => {
    const fn = vi.fn().mockResolvedValue(false);
    const result = await retryFetch(fn);
    expect(result).toBe(false);
  });

  it('should succeed on last retry attempt', async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return Promise.resolve('last-chance');
    });
    const result = await retryFetch(fn, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe('last-chance');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
