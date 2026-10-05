/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useUserStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn() }));

vi.mock('../../src/lib/ownProfile', () => ({
  ownProfile: () => ({
    select: () => ({ maybeSingle: mocks.maybeSingle }),
  }),
}));

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
    mocks.maybeSingle.mockReset();
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    useUserStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      currentClubId: null,
      totalChips: 0,
    });
  });

  it('should start with null user', () => {
    expect(useUserStore.getState().user).toBeNull();
  });

  it('should not be loading by default', () => {
    expect(useUserStore.getState().isLoading).toBe(false);
  });

  it('should have default chips of zero', () => {
    expect(useUserStore.getState().totalChips).toBe(0);
  });

  it('should login user via login action', () => {
    useUserStore.getState().login({ id: 'u1', display_name: 'TestUser' } as any);
    expect(useUserStore.getState().user).toBeDefined();
    expect(useUserStore.getState().isAuthenticated).toBe(true);
  });

  it('should set current club', () => {
    useUserStore.getState().setCurrentClub('club-1');
    expect(useUserStore.getState().currentClubId).toBe('club-1');
  });

  it('should update profile properties', () => {
    useUserStore.getState().setUser({ id: 'u2', display_name: 'Original' } as any);
    useUserStore.getState().updateProfile({ display_name: 'Changed' });
    expect(useUserStore.getState().user?.display_name).toBe('Changed');
  });

  it('discards a late A profile after the store switches to B', async () => {
    let resolveA!: (value: { data: Record<string, unknown>; error: null }) => void;
    const lateA = new Promise<{ data: Record<string, unknown>; error: null }>((resolve) => {
      resolveA = resolve;
    });
    mocks.maybeSingle.mockReturnValueOnce(lateA);
    useUserStore.getState().setUser({ id: 'user-a', username: 'A' } as any);

    const loadA = useUserStore.getState().loadProfile('user-a');
    useUserStore.getState().setUser({ id: 'user-b', username: 'B' } as any);
    resolveA({
      data: {
        id: 'user-a',
        username: 'A full',
        display_name: 'Account A',
        created_at: new Date().toISOString(),
      },
      error: null,
    });

    await expect(loadA).resolves.toBeNull();
    expect(useUserStore.getState().user?.id).toBe('user-b');
    expect(useUserStore.getState().user?.username).toBe('B');
    expect(useUserStore.getState().isLoading).toBe(false);
  });

  it('discards a late profile after logout without restoring loading state', async () => {
    let resolveA!: (value: { data: Record<string, unknown>; error: null }) => void;
    const lateA = new Promise<{ data: Record<string, unknown>; error: null }>((resolve) => {
      resolveA = resolve;
    });
    mocks.maybeSingle.mockReturnValueOnce(lateA);
    useUserStore.getState().setUser({ id: 'user-a', username: 'A' } as any);

    const loadA = useUserStore.getState().loadProfile('user-a');
    useUserStore.getState().logout();
    resolveA({
      data: {
        id: 'user-a',
        username: 'A full',
        display_name: 'Account A',
        created_at: new Date().toISOString(),
      },
      error: null,
    });

    await expect(loadA).resolves.toBeNull();
    expect(useUserStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  });

  it('should export store with all actions', () => {
    const state = useUserStore.getState();
    expect(typeof state.login).toBe('function');
    expect(typeof state.logout).toBe('function');
    expect(typeof state.setUser).toBe('function');
    expect(typeof state.updateProfile).toBe('function');
    expect(typeof state.loadProfile).toBe('function');
    expect(typeof state.setCurrentClub).toBe('function');
    expect(typeof state.updateTotalChips).toBe('function');
  });
});
