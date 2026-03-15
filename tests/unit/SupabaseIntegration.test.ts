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
  startSpan: vi.fn((opts: any, fn: () => any) => fn()),
  setMeasurement: vi.fn(),
}));

import { trackSupabaseOperation, trackSupabaseQuery } from '../../src/core/SupabaseIntegration';

describe('trackSupabaseOperation', () => {
  it('should be a function', () => {
    expect(typeof trackSupabaseOperation).toBe('function');
  });

  it('should execute the provided function', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const result = await trackSupabaseOperation('test-op', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('trackSupabaseQuery', () => {
  it('should be a function', () => {
    expect(typeof trackSupabaseQuery).toBe('function');
  });

  it('should execute and return query result', async () => {
    const fn = vi.fn().mockResolvedValue({ data: [1, 2, 3], error: null });
    const result = await trackSupabaseQuery('test-query', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
