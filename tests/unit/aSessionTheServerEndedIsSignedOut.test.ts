/**
 * A SESSION THE SERVER HAS ENDED IS ENDED HERE TOO (2026-09-29)
 *
 * After Close My Account on the Android emulator the app kept the closed
 * account's session: the server had removed it, the sign-out got 403
 * session_not_found, and @supabase/auth-js 2.90 returned that as
 * AuthSessionMissingError WITHOUT removing the local copy. The player stayed
 * "signed in" (a JWT valid for days on this project), saw "Your Session
 * Expired", then the scrubbed profile's Complete Your Profile card.
 *
 * The first block runs the REAL library against a server that answers the way
 * GoTrue answered (auth log 2026-09-29 05:34:56, POST /logout 403
 * session_not_found). Its first case pins the library's behaviour: when an
 * upgrade makes signOut() finish on its own, that case fails on purpose -
 * delete src/lib/forgetEndedSession.ts and its call in IdentityDNA.logout().
 * The second block holds IdentityDNA.logout() to finishing such a sign-out
 * instead of reporting and rethrowing it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AuthApiError,
  AuthSessionMissingError,
  createClient,
  isAuthSessionMissingError,
} from '@supabase/supabase-js';
import { forgetEndedSession } from '../../src/lib/forgetEndedSession';

const KEY = 'ended-session-test';
const USER_ID = '4344d850-bcd6-4f52-8c89-9c4318b3e099';

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

function storeActiveSession(userId: string): void {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    exp: now + 3600,
  })}.signature`;
  localStorage.setItem('smarter-poker-auth', JSON.stringify({ access_token: accessToken }));
}

function clientWhoseServerEndedTheSession() {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  };
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes('/auth/v1/logout')) {
      return new Response(
        JSON.stringify({
          code: 403,
          error_code: 'session_not_found',
          msg: 'Session from session_id claim in JWT does not exist',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createClient('https://example.supabase.co', 'anon-key', {
    auth: {
      storage,
      storageKey: KEY,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchImpl as typeof fetch },
  });
  const now = Math.floor(Date.now() / 1000);
  const accessToken = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub: USER_ID,
    role: 'authenticated',
    aud: 'authenticated',
    exp: now + 604800,
    session_id: '00000000-0000-4000-8000-000000000000',
  })}.signature`;
  stored.set(
    KEY,
    JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh',
      token_type: 'bearer',
      expires_in: 604800,
      expires_at: now + 604800,
      user: {
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: new Date().toISOString(),
      },
    })
  );
  return { client, stored, calls };
}

describe('supabase-js, against a server that already ended the session', () => {
  it('signOut() answers AuthSessionMissingError and KEEPS the local session (the library behaviour this works around)', async () => {
    const { client, stored, calls } = clientWhoseServerEndedTheSession();
    const { error } = await client.auth.signOut();
    expect(calls.some((u) => u.includes('/auth/v1/logout'))).toBe(true);
    expect(isAuthSessionMissingError(error)).toBe(true);
    expect(
      stored.has(KEY),
      'signOut() now removes the session itself: delete src/lib/forgetEndedSession.ts and its call in IdentityDNA.logout()'
    ).toBe(true);
  });

  it('forgetEndedSession() removes it and tells every listener SIGNED_OUT', async () => {
    const { client, stored } = clientWhoseServerEndedTheSession();
    const events: string[] = [];
    client.auth.onAuthStateChange((event) => {
      events.push(event);
    });
    await client.auth.signOut();
    await forgetEndedSession(client.auth);
    expect(stored.has(KEY)).toBe(false);
    expect(events).toContain('SIGNED_OUT');
    const { data } = await client.auth.getSession();
    expect(data.session).toBeNull();
  });
});

const h = vi.hoisted(() => ({
  signOut: vi.fn(),
  removeSession: vi.fn(async () => {}),
  reportError: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: h.signOut,
      _removeSession: h.removeSession,
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    },
    from: h.from,
    rpc: vi.fn(),
    channel: vi.fn(),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: h.reportError,
  reportWarning: vi.fn(),
}));

describe('IdentityDNA.logout()', () => {
  beforeEach(() => {
    h.signOut.mockReset();
    h.removeSession.mockClear();
    h.reportError.mockClear();
  });

  it('finishes a sign-out the server already made, without reporting or throwing', async () => {
    h.signOut.mockResolvedValue({ error: new AuthSessionMissingError() });
    const { identityDNA } = await import('../../src/core/IdentityDNA');
    await expect(identityDNA.logout()).resolves.toBeUndefined();
    expect(h.removeSession).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('still reports and rethrows a sign-out the server refused for another reason', async () => {
    h.signOut.mockResolvedValue({
      error: new AuthApiError('upstream failure', 500, 'unexpected_failure'),
    });
    const { identityDNA } = await import('../../src/core/IdentityDNA');
    await expect(identityDNA.logout()).rejects.toThrow('upstream failure');
    expect(h.removeSession).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary sign-out to the auth listener', async () => {
    h.signOut.mockResolvedValue({ error: null });
    const { identityDNA } = await import('../../src/core/IdentityDNA');
    await expect(identityDNA.logout()).resolves.toBeUndefined();
    expect(h.removeSession).not.toHaveBeenCalled();
  });

  /* A device that was signed in when the account was closed - on this device
     or another - still holds an access token that outlives the closure by
     days. Measured on the Android emulator: relaunched, the app went on as the
     scrubbed account, lobby and all. Its profile says 'deleted'; that ends it. */
  it('signs a closed account out when its profile says so, and never shows the tombstone', async () => {
    vi.useFakeTimers();
    const { useUserStore } = await import('../../src/stores/useUserStore');
    try {
      h.signOut.mockResolvedValue({ error: new AuthSessionMissingError() });
      const tombstone = { id: USER_ID, username: 'deleted-4344d850bcd6', status: 'deleted' };
      h.from.mockReturnValue({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: tombstone, error: null }) }),
        }),
      });
      const { identityDNA } = await import('../../src/core/IdentityDNA');
      storeActiveSession(USER_ID);
      useUserStore.getState().setUser({ id: USER_ID, username: 'a-player' });
      const shown = vi.spyOn(useUserStore.getState(), 'setUser');
      (
        identityDNA as unknown as { loadProfileInBackground(id: string): void }
      ).loadProfileInBackground(USER_ID);
      await vi.runAllTimersAsync();
      expect(h.signOut).toHaveBeenCalledTimes(1);
      expect(h.removeSession).toHaveBeenCalledTimes(1);
      expect(shown).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      localStorage.removeItem('smarter-poker-auth');
      useUserStore.getState().logout();
      vi.useRealTimers();
    }
  });

  it('shows an open account as it always did', async () => {
    vi.useFakeTimers();
    const { useUserStore } = await import('../../src/stores/useUserStore');
    try {
      const open = { id: USER_ID, username: 'a-player', status: 'active' };
      h.from.mockReturnValue({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: open, error: null }) }) }),
      });
      const { identityDNA } = await import('../../src/core/IdentityDNA');
      storeActiveSession(USER_ID);
      useUserStore.getState().setUser({ id: USER_ID, username: 'a-player' });
      const shown = vi.spyOn(useUserStore.getState(), 'setUser');
      (
        identityDNA as unknown as { loadProfileInBackground(id: string): void }
      ).loadProfileInBackground(USER_ID);
      await vi.runAllTimersAsync();
      expect(h.signOut).not.toHaveBeenCalled();
      expect(shown).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      localStorage.removeItem('smarter-poker-auth');
      useUserStore.getState().logout();
      vi.useRealTimers();
    }
  });
});
