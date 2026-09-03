/**
 * useAuthUser owns the session-to-Zustand handoff used by guarded pages.
 * A successful setUser() synchronously rerenders the hook, so these tests use
 * the real store — a passive mock cannot reproduce that lifecycle.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: authMocks.getSession,
    },
  },
}));

import { useAuthUser } from '../../src/hooks/useAuthUser';
import { useUserStore } from '../../src/stores/useUserStore';

describe('useAuthUser', () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    authMocks.getSession.mockResolvedValue({ data: { session: null } });
    useUserStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      loadProfile: vi.fn().mockResolvedValue(null),
    });
  });

  it('returns an existing user without hydrating again', () => {
    useUserStore.getState().setUser({ id: 'user-1', username: 'player' });
    const { result } = renderHook(() => useAuthUser());

    expect(result.current.user?.id).toBe('user-1');
    expect(result.current.isHydrating).toBe(false);
    expect(authMocks.getSession).not.toHaveBeenCalled();
  });

  it('clears hydration after an anonymous session check', async () => {
    const { result } = renderHook(() => useAuthUser());

    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    expect(authMocks.getSession).toHaveBeenCalledOnce();
    expect(result.current.user).toBeNull();
  });

  it('clears hydration after restoring a valid session', async () => {
    let resolveSession!: (value: unknown) => void;
    authMocks.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      })
    );

    const { result } = renderHook(() => useAuthUser());
    await waitFor(() => expect(result.current.isHydrating).toBe(true));

    await act(async () => {
      resolveSession({
        data: {
          session: {
            user: {
              id: 'restored-user',
              email: 'restored@example.com',
              user_metadata: { display_name: 'Restored Player' },
            },
          },
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.user?.id).toBe('restored-user');
      expect(result.current.isHydrating).toBe(false);
    });
    expect(result.current.user?.display_name).toBe('Restored Player');
  });
});
