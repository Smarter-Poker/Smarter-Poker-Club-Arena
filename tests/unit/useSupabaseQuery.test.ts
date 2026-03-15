/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSupabaseQuery
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
  },
}));

import { useSupabaseQuery } from '../../src/hooks/useSupabaseQuery';

describe('useSupabaseQuery', () => {
  it('should export useSupabaseQuery as a function', () => {
    expect(typeof useSupabaseQuery).toBe('function');
  });
});
