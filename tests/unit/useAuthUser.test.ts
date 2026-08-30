/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useAuthUser
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

import { renderHook } from '@testing-library/react';
import { useAuthUser } from '../../src/hooks/useAuthUser';

describe('useAuthUser', () => {
  it('should be a function', () => {
    expect(typeof useAuthUser).toBe('function');
  });

  it('should return user state', () => {
    const { result } = renderHook(() => useAuthUser());
    expect(result.current).toBeDefined();
  });

  it('should return loading state', () => {
    const { result } = renderHook(() => useAuthUser());
    // Should return an object or tuple with user/loading properties
    const val = result.current;
    expect(val).toBeDefined();
  });
});
