/**
 * AN ACTION THAT DID NOT ARRIVE IS SENT AGAIN, AS THE SAME ACTION (2026-10-04)
 *
 * A tap made while the link was changing - Wi-Fi to cellular, a tunnel, a
 * proxy answering for an engine it could not reach - used to end as "Server
 * unreachable", a sentence the felt suppresses as self-healing. Nothing was
 * healing: there was no retry and no toast, the action bar came back, and the
 * clock ran on against a player who believed they had acted.
 *
 * The engine has carried what makes a repeat safe since 2026-09-05: one
 * idempotency key per intent (a key it has run is answered verbatim, not run
 * twice) and the decision context (an action for a turn that has moved on is
 * refused). These tests pin that the client now uses them for the case they
 * were built for, that it stops inside the turn it is answering, and that the
 * player is told when it could not be delivered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldSurfaceError } from '../src/utils/safeErrorMessage';
import { formatPopupText } from '../src/utils/popupStyle';

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            access_token: JSON.parse(localStorage.getItem('smarter-poker-auth')!).access_token,
          },
        },
      }),
    },
  },
  getAuthUser: async () => ({ id: 'u1' }),
}));
vi.mock('../src/services/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/lib/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
  captureClientError: vi.fn(),
  isClientErrorSinkEnabled: () => false,
}));

const ok = (body: Record<string, unknown> = { success: true }) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const status = (code: number, body: Record<string, unknown> = {}) => ({
  ok: false,
  status: code,
  json: async () => body,
  clone: () => ({ json: async () => body }),
});
const dropped = () => Promise.reject(new TypeError('Failed to fetch'));
/** A request on a link that went quiet: no answer until it is aborted. */
const silent = (_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    );
  });

type Api = typeof import('../src/services/GameServerAPI');
let api: Api;
const keysOf = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).idempotencyKey);

beforeEach(async () => {
  vi.resetModules();
  // GameServerAPI imports its token reader lazily. Load it on the real clock:
  // a first import that is still resolving while the fake clock runs forward
  // reads as an auth wait that timed out, not as the case under test.
  await import('../src/lib/authToken');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  localStorage.setItem(
    'smarter-poker-auth',
    JSON.stringify({
      access_token: `e30.${btoa(JSON.stringify({ sub: 'u1', session_id: 'login-1', exp: 4102444800 }))}.sig`,
    })
  );
  api = await import('../src/services/GameServerAPI');
  api.__resetActionSpacingForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run a call to completion under fake timers. */
async function settle<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => {
    done = true;
  });
  for (let i = 0; i < 600 && !done; i++) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((r) => setImmediate(r));
  }
  return tracked;
}

describe('submitAction re-sends an action nobody answered', () => {
  it('a request cut twice by the network lands on the third send, under one key', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(dropped)
      .mockImplementationOnce(dropped)
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const res = await settle(api.submitAction('table-1', 'u1', 'call', undefined, 'ctx-1'));

    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = keysOf(fetchMock);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBeTruthy();
    // The same intent, byte for byte: the engine fingerprints the body.
    const bodies = fetchMock.mock.calls.map((c) => String((c[1] as RequestInit).body));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ action: 'call', actionContext: 'ctx-1' });
  });

  it.each([502, 503, 504])('a %i from the proxy is re-sent under the same key', async (code) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(status(code)).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const res = await settle(api.submitAction('table-1', 'u1', 'fold'));

    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(keysOf(fetchMock)).size).toBe(1);
  });

  it('a request that gets no answer is abandoned at its deadline and sent again', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(silent).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const started = Date.now();

    const res = await settle(api.submitAction('table-1', 'u1', 'check'));

    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(api.ENGINE_CLOCKED_CALL_TIMEOUT_MS + 1_000);
  });

  it('gives up inside the turn it is answering, and says so in words the felt will show', async () => {
    const fetchMock = vi.fn().mockImplementation(silent);
    vi.stubGlobal('fetch', fetchMock);
    const started = Date.now();

    const res = await settle(api.submitAction('table-1', 'u1', 'raise', 40));

    expect(res).toEqual({
      success: false,
      error: api.ACTION_NOT_DELIVERED_MESSAGE,
      code: 'ACTION_NOT_DELIVERED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(keysOf(fetchMock)).size).toBe(1);
    // Shorter than the shortest action clock (15s), with time left to act again.
    expect(Date.now() - started).toBeLessThanOrEqual(api.ACTION_DELIVERY_BUDGET_MS + 500);
    expect(api.ACTION_DELIVERY_BUDGET_MS).toBeLessThan(15_000);
  });

  it('the give-up sentence is not suppressed, is Title Case and has no em dash', () => {
    expect(shouldSurfaceError(api.ACTION_NOT_DELIVERED_MESSAGE)).toBe(true);
    expect(formatPopupText(api.ACTION_NOT_DELIVERED_MESSAGE)).toBe(
      api.ACTION_NOT_DELIVERED_MESSAGE
    );
    expect(api.ACTION_NOT_DELIVERED_MESSAGE).not.toContain(String.fromCharCode(0x2014));
    expect(api.ACTION_NOT_DELIVERED_MESSAGE).not.toMatch(/\d{3}/);
  });

  it('an answer from the engine is never re-sent: a rejection is final', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(status(400, { success: false, error: 'Not your turn' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await settle(api.submitAction('table-1', 'u1', 'call'));

    expect(res).toMatchObject({ success: false, error: 'Not your turn' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 500 is not re-sent: the handler ran and nobody knows how far', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(500));
    vi.stubGlobal('fetch', fetchMock);

    const res = await settle(api.submitAction('table-1', 'u1', 'call'));

    expect(res.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('two taps are two intents: a second action gets its own key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    await settle(api.submitAction('table-1', 'u1', 'check'));
    await settle(api.submitAction('table-1', 'u1', 'check'));

    const keys = keysOf(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('the calls that answer a clock cannot wait for ever', () => {
  it('a time bank request with no answer fails at its deadline instead of hanging', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(silent));
    const started = Date.now();

    const res = await settle(api.activateTimeBank('table-1'));

    expect(res.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(api.ENGINE_CLOCKED_CALL_TIMEOUT_MS + 500);
  });

  it('a heartbeat with no answer is a counted miss before the next beat is due', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(silent));
    const started = Date.now();

    const res = await settle(api.sendHeartbeat('table-1'));

    expect(res).toMatchObject({ success: false, code: 'HEARTBEAT_NOT_DELIVERED' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('a heartbeat past its deadline does not silence the heartbeat', () => {
  it('beats that time out are misses, and the next beat is still sent', async () => {
    const fetchMock = vi.fn().mockImplementation(silent);
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 5; i++) {
      expect(await settle(api.sendHeartbeat('table-1'))).toMatchObject({
        success: false,
        code: 'HEARTBEAT_NOT_DELIVERED',
      });
    }
    // Five beats, five requests: the thirty-second breaker pause never began,
    // so the first beat after the link returns is not withheld.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    fetchMock.mockResolvedValue(ok({ success: true, connected: true }));
    expect(await settle(api.sendHeartbeat('table-1'))).toMatchObject({ success: true });
  });
});

describe('"no game for this table" is an answer, not an outage', () => {
  it('a 404 heartbeat is named, and never opens the breaker every table shares', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(404, { error: 'Table engine not found' }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      expect(await settle(api.sendHeartbeat('closed-table'))).toMatchObject({
        success: false,
        code: 'TABLE_ENGINE_NOT_FOUND',
      });
    }
    // Every beat reached the network: the breaker never opened.
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // And the live table beside it is still heartbeated.
    fetchMock.mockResolvedValue(ok({ success: true, connected: true }));
    expect(await settle(api.sendHeartbeat('live-table'))).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('a server that really cannot be reached still opens the breaker', async () => {
    const fetchMock = vi.fn().mockImplementation(dropped);
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i++) await settle(api.sendHeartbeat('table-1'));
    const res = await settle(api.sendHeartbeat('table-1'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.success).toBe(false);
    expect(res.code).toBeUndefined();
  });
});
