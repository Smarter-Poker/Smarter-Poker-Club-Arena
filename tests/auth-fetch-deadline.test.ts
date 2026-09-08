import { GoTrueClient } from '@supabase/auth-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthWithDeadline, AUTH_FETCH_DEADLINE_MS } from '../src/lib/authFetchDeadline';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('authentication network deadline', () => {
  it('aborts a hung fetch and releases its caller without waiting for a late network outcome', async () => {
    const transport = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', transport);
    const result = fetchAuthWithDeadline('https://auth.test/auth/v1/token').catch((e) => e);
    await vi.advanceTimersByTimeAsync(AUTH_FETCH_DEADLINE_MS);
    expect((await result).name).toBe('AbortError');
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the deadline until the response body has completed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ arrayBuffer: () => new Promise(() => {}) }));
    const result = fetchAuthWithDeadline('https://auth.test/auth/v1/token').catch((e) => e);
    await vi.advanceTimersByTimeAsync(AUTH_FETCH_DEADLINE_MS);
    expect((await result).name).toBe('AbortError');
  });
  it('preserves a completed response and clears its deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"error":"unavailable"}', {
          status: 503,
          headers: { 'x-request-id': 'test' },
        })
      )
    );
    const response = await fetchAuthWithDeadline('https://auth.test/auth/v1/token');
    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('test');
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('honors caller cancellation and removes the listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const result = fetchAuthWithDeadline('https://auth.test/auth/v1/token', {
      signal: controller.signal,
    }).catch((e) => e);
    controller.abort();
    expect((await result).name).toBe('AbortError');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not send an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    await expect(
      fetchAuthWithDeadline('https://auth.test/auth/v1/token', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('the real auth SDK releases its lock after a stalled refresh', () => {
  it('retains the session on a network timeout and permits the next refresh', async () => {
    const key = 'deadline-sdk-test';
    const oldToken = `e30.${btoa(JSON.stringify({ sub: 'u', session_id: 's', exp: 4102444800 }))}.sig`;
    const storage = new Map<string, string>([
      [
        key,
        JSON.stringify({
          access_token: oldToken,
          refresh_token: 'original-refresh',
          expires_at: 4102444800,
          expires_in: 3600,
          token_type: 'bearer',
          user: { id: 'u' },
        }),
      ],
    ]);
    const client = new GoTrueClient({
      url: 'https://auth.test/auth/v1',
      storageKey: key,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      storage: {
        isServer: true,
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => {
          storage.set(k, v);
        },
        removeItem: (k) => {
          storage.delete(k);
        },
      },
      fetch: fetchAuthWithDeadline,
    });
    await client.initialize();
    const transport = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', transport);
    const refreshing = client.refreshSession();
    await vi.advanceTimersByTimeAsync(1);
    const queuedSession = client.getSession();
    let queueReleased = false;
    void queuedSession.then(() => {
      queueReleased = true;
    });
    expect(queueReleased).toBe(false);
    await vi.advanceTimersByTimeAsync(35_000);
    expect((await refreshing).error?.name).toBe('AuthRetryableFetchError');
    expect((await queuedSession).data.session?.access_token).toBe(oldToken);
    expect(JSON.parse(storage.get(key)!).refresh_token).toBe('original-refresh');
    transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: oldToken,
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'bearer',
          user: { id: 'u' },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    expect((await client.refreshSession()).error).toBeNull();
    expect(JSON.parse(storage.get(key)!).refresh_token).toBe('rotated-refresh');
    await client.stopAutoRefresh();
  });
});
