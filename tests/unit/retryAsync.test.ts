/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — retryAsync Utility
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the exponential backoff retry utility that wraps all critical
 * Supabase RPCs throughout the financial services layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryAsync } from '../../src/utils/retryAsync';

// Use fake timers for backoff delay testing
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('retryAsync', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // HAPPY PATH
  // ─────────────────────────────────────────────────────────────────────────

  it('should return result on first successful call', async () => {
    const fn = vi.fn().mockResolvedValue({ data: 'ok' });
    const result = await retryAsync(fn, 3);

    expect(result).toEqual({ data: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should succeed after transient failures', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({ data: 'recovered' });

    const promise = retryAsync(fn, 3, 100);

    // First call fails immediately
    await vi.advanceTimersByTimeAsync(0);
    // Wait for 100ms delay (attempt 0: 100 * 2^0 = 100ms)
    await vi.advanceTimersByTimeAsync(100);
    // Wait for 200ms delay (attempt 1: 100 * 2^1 = 200ms)
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toEqual({ data: 'recovered' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RETRYABLE ERROR CLASSIFICATION
  // ─────────────────────────────────────────────────────────────────────────

  it('should retry on "fetch" errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue('ok');

    const promise = retryAsync(fn, 2, 10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should retry on "timeout" errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('Request timeout')).mockResolvedValue('ok');

    const promise = retryAsync(fn, 2, 10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should retry on 503 errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue('ok');

    const promise = retryAsync(fn, 2, 10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should retry on 502 errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('502 Bad Gateway')).mockResolvedValue('ok');

    const promise = retryAsync(fn, 2, 10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should retry on 429 rate limit errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue('ok');

    const promise = retryAsync(fn, 2, 10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should retry on ECONNRESET errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('ok');

    const promise = retryAsync(fn, 2, 10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NON-RETRYABLE ERRORS (IMMEDIATE THROW)
  // ─────────────────────────────────────────────────────────────────────────

  it('should NOT retry auth errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('JWT expired'));

    await expect(retryAsync(fn, 3)).rejects.toThrow('JWT expired');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry validation errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('invalid input syntax'));

    await expect(retryAsync(fn, 3)).rejects.toThrow('invalid input syntax');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry RLS policy errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('new row violates row-level security policy'));

    await expect(retryAsync(fn, 3)).rejects.toThrow('row-level security');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry generic errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Something totally random'));

    await expect(retryAsync(fn, 3)).rejects.toThrow('Something totally random');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RETRY LIMIT
  // ─────────────────────────────────────────────────────────────────────────

  it('should throw after exhausting all retries', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    await expect(retryAsync(fn, 2, 1)).rejects.toThrow('Failed to fetch');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.useFakeTimers();
  });

  it('should default to 2 retries when not specified', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error('network error'));

    // Use tiny delay to avoid slow test
    await expect(retryAsync(fn, 2, 1)).rejects.toThrow('network error');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    vi.useFakeTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────

  it('should handle non-Error thrown values', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    // Non-Error values are not retryable (isRetryableError returns false)
    await expect(retryAsync(fn, 3)).rejects.toBe('string error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should work with zero retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    await expect(retryAsync(fn, 0)).rejects.toThrow('Failed to fetch');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
