/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — usePlayerStats
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
    },
  };
});

vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: vi.fn(() => ({ user: null })),
}));

import { renderHook } from '@testing-library/react';
import { usePlayerStats } from '../../src/hooks/usePlayerStats';

describe('usePlayerStats', () => {
  it('should be a function export', () => {
    expect(typeof usePlayerStats).toBe('function');
  });

  it('should return stats object', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(result.current).toBeDefined();
  });

  it('should return handsPlayed as number', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(typeof result.current.handsPlayed).toBe('number');
  });

  it('should return vpipCount as number', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(typeof result.current.vpipCount).toBe('number');
  });
});
