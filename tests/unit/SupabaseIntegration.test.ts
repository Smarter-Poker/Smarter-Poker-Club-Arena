/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SupabaseIntegration
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

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

vi.mock('@sentry/react', () => ({
  startSpan: vi.fn((_opts: any, fn: any) => fn()),
  setMeasurement: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
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
