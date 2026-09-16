/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SupabaseIntegration
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

import { trackSupabaseOperation, trackSupabaseQuery } from '../../src/core/SupabaseIntegration';

describe('trackSupabaseOperation', () => {
  it('should be a function', () => {
    expect(typeof trackSupabaseOperation).toBe('function');
  });

  it('should execute the provided promise and return result', async () => {
    const result = await trackSupabaseOperation('test-table', 'select', Promise.resolve('result'));
    expect(result).toBe('result');
  });
});

describe('trackSupabaseQuery', () => {
  it('should be a function', () => {
    expect(typeof trackSupabaseQuery).toBe('function');
  });

  it('should execute query promise-like', async () => {
    const mockResult = { data: [1, 2, 3], error: null };
    const result = await trackSupabaseQuery('test-table', 'select', Promise.resolve(mockResult));
    expect(result).toEqual(mockResult);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('local database failure visibility', () => {
  it('returns the same failed result and reports RLS failures locally', async () => {
    const error = Object.freeze({ code: '42501', message: 'permission denied' });
    const result = { data: null, error };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(trackSupabaseQuery('wallet', 'select', Promise.resolve(result))).resolves.toBe(
      result
    );
    expect(log).toHaveBeenCalledWith(
      '[Supabase.wallet.select]',
      expect.objectContaining({ message: '[Supabase.wallet.select] permission denied' })
    );
    expect(warn).toHaveBeenCalledWith('[Supabase.wallet.select] RLS Policy Violation', {
      code: '42501',
    });
    expect(error.message).toBe('permission denied');
  });
  it('preserves the exact rejection even if the console sink fails', async () => {
    const error = Object.freeze(new Error('transport unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('log sink failed');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('log sink failed');
    });
    await expect(trackSupabaseOperation('wallet', 'read', Promise.reject(error))).rejects.toBe(
      error
    );
    expect(error.message).toBe('transport unavailable');
  });
});
