/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSupabaseQuery
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  },
}));

import { useSupabaseQuery } from '../../src/hooks/useSupabaseQuery';
import { supabase } from '../../src/lib/supabase';

describe('useSupabaseQuery', () => {
  it('should export useSupabaseQuery as a function', () => {
    expect(typeof useSupabaseQuery).toBe('function');
  });

  it('should return { data, loading, error, refetch }', () => {
    const queryFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useSupabaseQuery('test', queryFn));
    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('loading');
    expect(result.current).toHaveProperty('error');
    expect(typeof result.current.refetch).toBe('function');
  });

  it('should start in loading state', () => {
    const queryFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useSupabaseQuery('test', queryFn));
    expect(result.current.loading).toBe(true);
  });
});
