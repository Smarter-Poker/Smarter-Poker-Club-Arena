/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE CLIENT BEACON CANNOT STORM, AND CANNOT REACH THE TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Realtime Phase 2 (2026-09-05). The beacon exists because a 22-hour outage
 * was invisible - but the outage it describes is a retry every few seconds
 * for a day, on a connection that is already failing. Telemetry about a
 * failure must not become part of the failure.
 *
 * PINS
 *   1. One beacon per reason per minute, however often it is called.
 *   2. It never throws and never returns a promise the caller could await -
 *      no path a hand depends on can be delayed by it.
 *   3. Signed out, it sends nothing (there is nobody to attribute it to).
 *   4. A failing request is swallowed; there is no retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getFreshAccessToken = vi.fn(async () => 'tok' as string | null);
vi.mock('../src/lib/authToken', () => ({ getFreshAccessToken: () => getFreshAccessToken() }));

let reportConnectionEvent: typeof import('../src/services/clientConnectionBeacon').reportConnectionEvent;
let _resetBeaconThrottle: typeof import('../src/services/clientConnectionBeacon')._resetBeaconThrottle;
let THROTTLE_MS: number;

beforeEach(async () => {
  vi.resetModules();
  getFreshAccessToken.mockReset();
  getFreshAccessToken.mockResolvedValue('tok');
  const mod = await import('../src/services/clientConnectionBeacon');
  reportConnectionEvent = mod.reportConnectionEvent;
  _resetBeaconThrottle = mod._resetBeaconThrottle;
  THROTTLE_MS = mod.THROTTLE_MS;
  _resetBeaconThrottle();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('LAW 1 - a reconnect storm is not a request storm', () => {
  it('sends once per reason per throttle window, however often it is called', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 200; i++) reportConnectionEvent('closed');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different reason is its own budget - a socket can fail two ways at once.
    reportConnectionEvent('stale');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Still throttled inside the window.
    for (let i = 0; i < 50; i++) reportConnectionEvent('closed');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // After the window it may speak again.
    vi.advanceTimersByTime(THROTTLE_MS + 1000);
    reportConnectionEvent('closed');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('posts only the reason - the server takes the user from the token', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    reportConnectionEvent('auth_failed');
    await flush();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/client-event$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'auth_failed' });
    expect(String(init.body)).not.toMatch(/user/i);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.keepalive).toBe(true);
  });
});

describe('LAW 2/3/4 - it can never reach the table', () => {
  it('returns undefined synchronously, so nothing can await it', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    expect(reportConnectionEvent('stale')).toBeUndefined();
  });

  it('a failing request is swallowed and never retried', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(() => reportConnectionEvent('closed')).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('signed out, it sends nothing', async () => {
    getFreshAccessToken.mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    reportConnectionEvent('closed');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
