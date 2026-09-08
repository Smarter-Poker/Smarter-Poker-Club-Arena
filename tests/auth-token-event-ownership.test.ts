import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
}));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth } }));
vi.mock('../src/lib/authUtils', () => ({
  readLocalSession: () => null,
  getTokenExpiry: () => Date.now() + 3_600_000,
}));

function pendingSession() {
  let resolve!: (value: { data: { session: { access_token: string } | null } }) => void;
  const promise = new Promise<{ data: { session: { access_token: string } | null } }>((yes) => {
    resolve = yes;
  });
  return {
    promise,
    finish: (token: string | null) =>
      resolve({ data: { session: token ? { access_token: token } : null } }),
  };
}

let emit: (event: string, session: { access_token: string } | null) => void;
beforeEach(() => {
  vi.resetModules();
  auth.getSession.mockReset();
  auth.onAuthStateChange.mockImplementation((callback) => {
    emit = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
});

describe('auth cache event ownership', () => {
  it('does not restore the initialization token after sign-out', async () => {
    const initial = pendingSession();
    auth.getSession.mockReturnValue(initial.promise);
    const cache = await import('../src/lib/authToken');
    cache.initAuthTokenCache();
    await vi.waitFor(() => expect(auth.getSession).toHaveBeenCalledTimes(1));
    emit('SIGNED_OUT', null);
    initial.finish('obsolete-token');
    await initial.promise;
    await Promise.resolve();
    expect(cache.getCachedAccessToken()).toBeNull();
  });

  it.each([null, 'new-account-token'])(
    'ignores a slow lookup after an auth event (%s)',
    async (newToken) => {
      auth.getSession.mockResolvedValueOnce({ data: { session: null } });
      const cache = await import('../src/lib/authToken');
      cache.initAuthTokenCache();
      await vi.waitFor(() => expect(auth.getSession).toHaveBeenCalledTimes(1));
      const old = pendingSession();
      auth.getSession.mockReturnValueOnce(old.promise);
      const reading = cache.getFreshAccessToken();
      await vi.waitFor(() => expect(auth.getSession).toHaveBeenCalledTimes(2));
      emit(newToken ? 'SIGNED_IN' : 'SIGNED_OUT', newToken ? { access_token: newToken } : null);
      old.finish('obsolete-token');
      expect(await reading).toBe(newToken);
      expect(cache.getCachedAccessToken()).toBe(newToken);
    }
  );

  it('adopts a completed lookup when no auth event superseded it', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    const cache = await import('../src/lib/authToken');
    cache.initAuthTokenCache();
    await vi.waitFor(() => expect(auth.getSession).toHaveBeenCalledTimes(1));
    auth.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'current-token' } } });
    expect(await cache.getFreshAccessToken()).toBe('current-token');
    expect(cache.getCachedAccessToken()).toBe('current-token');
  });
});
