/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useUserStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    },
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { useUserStore } from '../../src/stores/useUserStore';

describe('useUserStore', () => {
  beforeEach(() => {
    useUserStore.setState({
      user: null,
      isLoading: false,
      currentClubId: null,
      stats: { handsPlayed: 0, winRate: 0, totalProfit: 0, avgSessionMinutes: 0 },
    });
  });

  it('should start with null user', () => {
    expect(useUserStore.getState().user).toBeNull();
  });

  it('should not be loading by default', () => {
    expect(useUserStore.getState().isLoading).toBe(false);
  });

  it('should have default stats of zero', () => {
    const stats = useUserStore.getState().stats;
    expect(stats.handsPlayed).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.totalProfit).toBe(0);
  });

  it('should set user via setUser', () => {
    useUserStore.getState().setUser({ id: 'u1', display_name: 'TestUser' } as any);
    expect(useUserStore.getState().user).toBeDefined();
    expect(useUserStore.getState().user?.id).toBe('u1');
  });

  it('should set current club', () => {
    useUserStore.getState().setCurrentClub('club-1');
    expect(useUserStore.getState().currentClubId).toBe('club-1');
  });

  it('should clear current club', () => {
    useUserStore.getState().setCurrentClub('club-1');
    useUserStore.getState().setCurrentClub(null);
    expect(useUserStore.getState().currentClubId).toBeNull();
  });

  it('should update stats', () => {
    useUserStore
      .getState()
      .updateStats({ handsPlayed: 100, winRate: 55.5, totalProfit: 1200, avgSessionMinutes: 90 });
    const stats = useUserStore.getState().stats;
    expect(stats.handsPlayed).toBe(100);
    expect(stats.winRate).toBe(55.5);
  });

  it('should export store with all actions', () => {
    const state = useUserStore.getState();
    expect(typeof state.setUser).toBe('function');
    expect(typeof state.setCurrentClub).toBe('function');
    expect(typeof state.updateStats).toBe('function');
    expect(typeof state.fetchProfile).toBe('function');
  });
});
