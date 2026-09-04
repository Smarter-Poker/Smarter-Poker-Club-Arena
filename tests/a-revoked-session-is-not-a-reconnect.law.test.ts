/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A REVOKED SESSION IS NOT A RECONNECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04: "ALL TABLES INSIDE THE CLUB ARENA ARE CURRENTLY DOWN,
 * NOBODY CAN PLAY... THEY ALL JUST SAY 'RECONNECTING TO TABLE' AND IT NEVER
 * DOES... JUST SILENTLY FAILS."
 *
 * The engine was dealing 5,700 hands per ten minutes. What was dead was his
 * SESSION: a World Hub cron pointed at his account called a global signOut()
 * every fifteen minutes. The engine's auth.getUser() got session_not_found,
 * refused the upgrade with a pre-handshake 401, the browser reported that as
 * close code 1006 - a dropped link - and EngineStateClient reconnected with
 * the same dead token on its backoff ladder for twenty-two hours. The lobby
 * still worked (PostgREST checks signatures, not sessions) and the token had
 * seven days to live (no refresh was ever tried), so nothing ever said
 * "you are signed out".
 *
 * THE PINS
 *   1. A close the engine marks as AUTH (4401, or an `auth:` reason) asks
 *      GoTrue whether the session is alive, immediately.
 *   2. Three failed handshakes in a row ask too - that is what a bare 401
 *      looks like from a browser. Two do not; one is a normal engine restart.
 *   3. "Could not ask" is never "revoked". A network error, a 5xx, a thrown
 *      fetch - the ladder keeps running. "The games can never freeze or die"
 *      (2026-08-21) still holds for a live session on a bad link.
 *   4. A definitively dead session - GoTrue says so, and a refresh says so
 *      too - stops the ladder: there is nothing to reconnect WITH. The player
 *      is sent to sign in, with a return path to the table, and the local
 *      session is cleared with scope 'local' only.
 *   5. The login redirect carries `authError=no_session` - a code the World
 *      Hub login page renders as copy - and the SPA base exactly once.
 *
 * IF THIS FILE GOES RED, YOUR CHANGE IS THE BUG. Do not lower the
 * three-failure threshold to "never", do not make an unknown verdict sign
 * anyone out, and do not make a revoked one keep spinning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeSessionAlive,
  isDefinitiveAuthRejection,
  isEngineAuthClose,
  loginRedirectUrl,
  announceSessionEnded,
  SESSION_ENDED_TITLE,
  SESSION_ENDED_BODY,
  SESSION_ENDED_BUTTON,
  SESSION_ENDED_PROMPT_MS,
  _resetSessionRevokedStateForTests,
} from '../src/lib/sessionRevoked';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Pin 3 + 4: the verdict logic, no network ────────────────────────────────

type AuthErr = { status?: number; code?: string; message?: string } | null;
function fakeAuth(opts: { getUser?: AuthErr | 'throw'; refresh?: AuthErr | 'throw' }) {
  return {
    getUser: vi.fn(async () => {
      if (opts.getUser === 'throw') throw new TypeError('Failed to fetch');
      return opts.getUser
        ? { data: { user: null }, error: opts.getUser }
        : { data: { user: { id: 'u1' } }, error: null };
    }),
    refreshSession: vi.fn(async () => {
      if (opts.refresh === 'throw') throw new TypeError('Failed to fetch');
      return opts.refresh
        ? { data: { session: null }, error: opts.refresh }
        : { data: { session: { access_token: 'new' } }, error: null };
    }),
    signOut: vi.fn(async () => ({ error: null })),
  };
}

describe('LAW 3/4 - the verdict', () => {
  it('a live session is alive, and no refresh is attempted', async () => {
    const a = fakeAuth({});
    expect(await probeSessionAlive(a)).toBe('alive');
    expect(a.refreshSession).not.toHaveBeenCalled();
  });

  it('the outage: session_not_found on getUser AND on refresh is REVOKED', async () => {
    const a = fakeAuth({
      getUser: {
        status: 403,
        code: 'session_not_found',
        message: 'Session from session_id claim in JWT does not exist',
      },
      refresh: {
        status: 400,
        code: 'refresh_token_not_found',
        message: 'Invalid Refresh Token: Refresh Token Not Found',
      },
    });
    expect(await probeSessionAlive(a)).toBe('revoked');
  });

  it('a dead access token with a LIVE refresh token is alive (rotated signing key, not a sign-out)', async () => {
    const a = fakeAuth({ getUser: { status: 403, code: 'bad_jwt' } });
    expect(await probeSessionAlive(a)).toBe('alive');
    expect(a.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('a network error is UNKNOWN, never revoked (getUser throws)', async () => {
    expect(await probeSessionAlive(fakeAuth({ getUser: 'throw' }))).toBe('unknown');
  });

  it('a network error on the refresh is UNKNOWN, never revoked', async () => {
    const a = fakeAuth({ getUser: { status: 403, code: 'session_not_found' }, refresh: 'throw' });
    expect(await probeSessionAlive(a)).toBe('unknown');
  });

  it('a 5xx / 429 / status-0 from GoTrue is UNKNOWN, never revoked', async () => {
    for (const status of [0, 429, 500, 502, 503]) {
      expect(await probeSessionAlive(fakeAuth({ getUser: { status, message: 'x' } }))).toBe(
        'unknown'
      );
      const a = fakeAuth({
        getUser: { status: 403, code: 'session_not_found' },
        refresh: { status, message: 'x' },
      });
      expect(await probeSessionAlive(a)).toBe('unknown');
    }
  });

  it('isDefinitiveAuthRejection knows a dead session from a bad day', () => {
    expect(isDefinitiveAuthRejection({ status: 403, code: 'session_not_found' })).toBe(true);
    expect(isDefinitiveAuthRejection({ status: 401 })).toBe(true);
    expect(
      isDefinitiveAuthRejection({ status: 400, message: 'Invalid Refresh Token: Already Used' })
    ).toBe(true);
    expect(isDefinitiveAuthRejection({ code: 'refresh_token_not_found' })).toBe(true);
    expect(isDefinitiveAuthRejection({ status: 500 })).toBe(false);
    expect(isDefinitiveAuthRejection({ status: 0, message: 'Failed to fetch' })).toBe(false);
    expect(isDefinitiveAuthRejection({ status: 400, message: 'Validation failed' })).toBe(false);
    expect(isDefinitiveAuthRejection(null)).toBe(false);
  });
});

describe('LAW 1/5 - the wire signals', () => {
  it('4401, or an auth: reason, is an auth close; 1006 alone is not', () => {
    expect(isEngineAuthClose(4401, '')).toBe(true);
    expect(isEngineAuthClose(4401, 'auth:session_not_found')).toBe(true);
    expect(isEngineAuthClose(1006, 'auth:bad_jwt')).toBe(true);
    expect(isEngineAuthClose(1006, '')).toBe(false);
    expect(isEngineAuthClose(4404, 'table_not_found')).toBe(false);
    expect(isEngineAuthClose(undefined, undefined)).toBe(false);
  });

  it('the login redirect carries the no_session code and the SPA base exactly once', () => {
    const fromWindow = loginRedirectUrl('/hub/club-arena/table/abc', '?x=1');
    expect(fromWindow).toBe(
      '/auth/login?authError=no_session&redirect=' +
        encodeURIComponent('/hub/club-arena/table/abc?x=1')
    );
    const fromRouter = loginRedirectUrl('/table/abc', '');
    expect(fromRouter).toBe(
      '/auth/login?authError=no_session&redirect=' + encodeURIComponent('/hub/club-arena/table/abc')
    );
    expect(fromWindow).not.toContain('club-arena%2Fhub');
  });
});

// ─── Pin 6: THE PLAYER IS TOLD (Dan 2026-09-04: "NOT JUST SILENTLY FAIL") ──

describe('LAW 6 - a dead session is announced to the player, never a silent bounce', () => {
  afterEach(() => {
    document.getElementById('ca-session-ended')?.remove();
    vi.useRealTimers();
  });

  it('renders a prompt that says why, with a button, before leaving', () => {
    vi.useFakeTimers();
    const go = vi.fn();
    announceSessionEnded(go);
    const el = document.getElementById('ca-session-ended');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('alertdialog');
    expect(el!.textContent).toContain(SESSION_ENDED_TITLE);
    expect(el!.textContent).toContain(SESSION_ENDED_BODY);
    expect(go).not.toHaveBeenCalled();
    // The button goes now; the timer goes on its own; never twice.
    (el!.querySelector('button') as HTMLButtonElement).click();
    expect(go).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SESSION_ENDED_PROMPT_MS + 100);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('leaves on its own if the player does nothing', () => {
    vi.useFakeTimers();
    const go = vi.fn();
    announceSessionEnded(go);
    vi.advanceTimersByTime(SESSION_ENDED_PROMPT_MS + 100);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('the copy obeys the popup rule: Title Case, no em dashes, and it names the cause', () => {
    for (const text of [SESSION_ENDED_TITLE, SESSION_ENDED_BODY, SESSION_ENDED_BUTTON]) {
      expect(text).not.toContain('\u2014');
      for (const word of text.split(/\s+/)) {
        const first = word.replace(/^[^A-Za-z]+/, '')[0];
        if (first) expect(first, `"${word}" in "${text}"`).toBe(first.toUpperCase());
      }
    }
    expect(SESSION_ENDED_BODY).toMatch(/Signed Out/);
    expect(SESSION_ENDED_BODY).toMatch(/Sign In/);
  });

  it('the revoked path calls the prompt, and the banner no longer claims to be signing in', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'sessionRevoked.ts'), 'utf8');
    const revokedAt = src.indexOf("if (verdict === 'revoked')");
    expect(revokedAt).toBeGreaterThan(0);
    // The block has inner try/catches (sessionStorage, signOut); bound it by
    // the finally that ends the probe, not by the first catch it contains.
    const revokedBlock = src.slice(revokedAt, src.indexOf('inFlight = null', revokedAt));
    expect(revokedBlock).toContain('announceSessionEnded(');
    // The redirect must live INSIDE the prompt's callback: no assign may
    // appear before announceSessionEnded( is called, and there is only one.
    const announceAt = revokedBlock.indexOf('announceSessionEnded(');
    const assignAt = revokedBlock.indexOf('window.location.assign(');
    expect(assignAt).toBeGreaterThan(announceAt);
    expect(revokedBlock.split('window.location.assign(').length - 1).toBe(1);
    const banner = readFileSync(
      join(__dirname, '..', 'src', 'components', 'table', 'TableConnectionBanner.tsx'),
      'utf8'
    );
    expect(banner).not.toMatch(/return 'Signing You In Again'/);
  });
});

// ─── Pins 1, 2, 3, 4 against the real EngineStateClient ──────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const TABLE = 'aaaaaaaa-2222-4222-8222-222222222222';
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

type Verdict = 'alive' | 'revoked' | 'unknown';
let verdict: Verdict = 'unknown';
const rejections: string[] = [];

vi.mock('../src/lib/sessionRevoked', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/sessionRevoked')>();
  return {
    ...real,
    handleEngineAuthRejection: vi.fn(async (source: string) => {
      rejections.push(source);
      return verdict;
    }),
  };
});

let EngineStateClient: typeof import('../src/services/EngineStateClient').EngineStateClient;
let HANDSHAKE_FAILURES_BEFORE_SESSION_CHECK: number;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  rejections.length = 0;
  verdict = 'unknown';
  _resetSessionRevokedStateForTests();
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Mux OFF: pin the direct socket path. The mux fans the same close code
  // and reason out to every facade, so the client logic is shared.
  try {
    localStorage.setItem('ca_ws_mux', '0');
  } catch {
    /* no storage in this environment */
  }
  vi.resetModules();
  const mod = await import('../src/services/EngineStateClient');
  EngineStateClient = mod.EngineStateClient;
  HANDSHAKE_FAILURES_BEFORE_SESSION_CHECK = mod.HANDSHAKE_FAILURES_BEFORE_SESSION_CHECK;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const statuses: string[] = [];
  const c = new EngineStateClient({
    baseUrl: 'https://engine.example',
    tableId: TABLE,
    getToken: async () => 'dead-token',
    onSnapshot: () => undefined,
    onStatus: (s: string) => statuses.push(s),
    onError: () => undefined,
    initialDelay: 10,
    maxDelay: 50,
  } as never);
  return { c, statuses };
}
const live = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe('LAW 1 - an auth close asks GoTrue at once', () => {
  it('4401 with an auth: reason -> auth_failed, one session check, and (unknown) the ladder continues', async () => {
    const { c, statuses } = client();
    c.connect();
    await flush();
    expect(FakeWebSocket.instances.length).toBe(1);
    live()._serverClose(4401, 'auth:session_not_found');
    await flush();
    expect(statuses).toContain('auth_failed');
    expect(rejections).toEqual(['table:4401']);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    c.disconnect();
  });

  it('threshold is three, and it is exported so nobody can quietly change it', () => {
    expect(HANDSHAKE_FAILURES_BEFORE_SESSION_CHECK).toBe(3);
  });
});

describe('LAW 2 - a bare 401 looks like 1006, and three of those ask too', () => {
  it('two 1006 closes do not ask; the third does', async () => {
    const { c } = client();
    c.connect();
    await flush();
    live()._serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    live()._serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    expect(rejections).toEqual([]);
    live()._serverClose(1006);
    await flush();
    expect(rejections).toEqual(['table:1006x3']);
    c.disconnect();
  });

  it('a successful open resets the count - a flaky link never accumulates into a session check', async () => {
    const { c } = client();
    c.connect();
    await flush();
    live()._serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    live()._serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    live()._open();
    live()._serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    live()._serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    expect(rejections).toEqual([]);
    c.disconnect();
  });
});

describe('LAW 3 - could-not-ask keeps the ladder running', () => {
  it('verdict unknown after three 1006s: a new socket is still opened', async () => {
    verdict = 'unknown';
    const { c } = client();
    c.connect();
    await flush();
    for (let i = 0; i < 3; i++) {
      live()._serverClose(1006);
      await vi.advanceTimersByTimeAsync(100);
    }
    const before = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before - 1);
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    c.disconnect();
  });

  it('verdict alive: the ladder never stops (the games can never freeze or die)', async () => {
    verdict = 'alive';
    const { c, statuses } = client();
    c.connect();
    await flush();
    live()._serverClose(4401, 'auth:bad_jwt');
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(statuses[statuses.length - 1]).not.toBe('failed');
    c.disconnect();
  });
});

describe('LAW 4 - a revoked session stops the ladder; the player is sent to sign in', () => {
  it('verdict revoked: status auth_failed, and NO further socket is opened', async () => {
    verdict = 'revoked';
    const { c, statuses } = client();
    c.connect();
    await flush();
    live()._serverClose(4401, 'auth:session_not_found');
    await flush();
    const after = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances.length).toBe(after);
    expect(statuses[statuses.length - 1]).toBe('auth_failed');
    c.disconnect();
  });
});
