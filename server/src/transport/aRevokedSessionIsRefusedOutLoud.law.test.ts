/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A REVOKED SESSION IS REFUSED OUT LOUD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04: every table sat on "Reconnecting To The Table" for 22
 * hours while the engine dealt 5,700 hands per ten minutes. His session had
 * been revoked (a cron signing him out globally every 15 minutes); the
 * engine's auth.getUser() said session_not_found; both upgrade handlers wrote
 * a bare `HTTP/1.1 401` BEFORE the WebSocket handshake. A browser reports a
 * pre-handshake refusal as close code 1006 - the same code as a dropped
 * link - so the client could not tell "your session is dead" from "the
 * Wi-Fi blinked", and did the only thing 1006 can mean: reconnect with the
 * same dead token, forever.
 *
 * THE PINS (client-side counterpart: tests/a-revoked-session-is-not-a-reconnect)
 *   1. A token GoTrue DEFINITIVELY rejects (401/403/404: session_not_found,
 *      bad_jwt, user_not_found) completes the handshake and is closed with
 *      4401 and an `auth:<code>` reason - on /ws/table, /ws/multi and
 *      /ws/channel alike. That is CLOSE_AUTH_FAILED, which the client has
 *      handled since it was written; the server had simply never sent it.
 *   2. A token we merely COULD NOT CHECK (GoTrue unreachable, 5xx, 429) is
 *      NOT refused as invalid. It gets a pre-handshake 503 - which the client
 *      sees as 1006 and keeps retrying - because an auth outage is not the
 *      player's fault and must never sign anyone out.
 *   3. `classifyGetUserError` is the single place that decides which is
 *      which, so the two servers cannot drift.
 *
 * IF THIS FILE GOES RED, YOUR CHANGE IS THE BUG. Do not turn the 503 into a
 * 4401 "for consistency": that is how a Supabase blip would log every player
 * out. Do not turn the 4401 back into a pre-handshake 401: that is the
 * outage.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })),
  },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../hub/ChannelHub.js', () => ({
  channelHub: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    leaveAll: vi.fn(),
    handleMessage: vi.fn(),
    removeConnection: vi.fn(),
  },
}));

import { EngineWebSocketServer } from './EngineWebSocketServer.js';
import {
  classifyGetUserError,
  verifySupabaseToken,
  authRejectionReason,
  tokenDenial,
  type TokenVerdict,
} from './wsHelpers.js';

const TABLE = '11111111-1111-4111-8111-111111111111';
// Three base64url segments: passes extractBearerToken's shape check.
const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln';

describe('LAW 3 - one classifier decides invalid vs unavailable', () => {
  it('GoTrue 401/403/404 with a code is INVALID', () => {
    expect(classifyGetUserError({ status: 403, code: 'session_not_found' })).toEqual({
      denied: 'invalid',
      code: 'session_not_found',
    });
    expect(classifyGetUserError({ status: 403, code: 'bad_jwt' })).toEqual({
      denied: 'invalid',
      code: 'bad_jwt',
    });
    expect(classifyGetUserError({ status: 401 })).toEqual({ denied: 'invalid', code: 'http_401' });
    expect(classifyGetUserError({ status: 404, code: 'user_not_found' }).denied).toBe('invalid');
  });

  it('a fetch failure, 429 or 5xx is UNAVAILABLE', () => {
    expect(classifyGetUserError({ status: 0, message: 'fetch failed' })).toEqual({
      denied: 'unavailable',
      code: 'unreachable',
    });
    expect(classifyGetUserError({ status: 500 }).denied).toBe('unavailable');
    expect(classifyGetUserError({ status: 503, code: 'unexpected_failure' }).denied).toBe(
      'unavailable'
    );
    expect(classifyGetUserError({ status: 429, code: 'over_request_rate_limit' }).denied).toBe(
      'unavailable'
    );
    expect(classifyGetUserError(null).denied).toBe('unavailable');
  });

  it('verifySupabaseToken maps getUser to a verdict and never throws', async () => {
    const ok = { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) };
    expect(await verifySupabaseToken(ok, JWT)).toEqual({ userId: 'u1' });
    const dead = {
      getUser: async () => ({
        data: { user: null },
        error: { status: 403, code: 'session_not_found' },
      }),
    };
    expect(await verifySupabaseToken(dead, JWT)).toEqual({
      denied: 'invalid',
      code: 'session_not_found',
    });
    const down = {
      getUser: async () => {
        throw Object.assign(new Error('fetch failed'), { status: 0 });
      },
    };
    expect((await verifySupabaseToken(down, JWT)).denied).toBe('unavailable');
    expect(await verifySupabaseToken(ok, '')).toEqual({ denied: 'invalid', code: 'missing' });
  });

  it('the close reason is short, mechanical and auth:-prefixed', () => {
    expect(authRejectionReason('session_not_found')).toBe('auth:session_not_found');
    expect(authRejectionReason('Bad JWT!! <x>')).toMatch(/^auth:bad_jwt_+x_$/);
    expect(authRejectionReason('').startsWith('auth:')).toBe(true);
    expect(authRejectionReason('x'.repeat(500)).length).toBeLessThanOrEqual(123);
  });

  it('tokenDenial: null from a legacy verifier is INVALID, a userId is not a denial', () => {
    expect(tokenDenial(null)).toEqual({ denied: 'invalid', code: 'invalid' });
    expect(tokenDenial({ userId: 'u1' })).toBeNull();
    expect(tokenDenial({ denied: 'unavailable', code: 'http_503' })?.denied).toBe('unavailable');
  });
});

// ─── Pins 1 and 2 over a real socket ─────────────────────────────────────────

let http: Server;
let port: number;
let verdict: TokenVerdict | null = { userId: 'u1' };

beforeAll(async () => {
  http = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const server = new EngineWebSocketServer({
    hub: { subscribe: vi.fn(), unsubscribe: vi.fn(), resync: vi.fn() } as never,
    tableExists: (id: string) => id === TABLE,
    verifyToken: async () => verdict,
    authorizeViewer: async () => ({ allowed: true, reason: 'club_member', clubId: 'c1' }),
  } as never);
  (server as unknown as { isBannedFromTable: unknown }).isBannedFromTable = vi
    .fn()
    .mockResolvedValue(false);
  (server as unknown as { isIpConflict: unknown }).isIpConflict = vi.fn().mockResolvedValue(false);
  (server as unknown as { isRestrictedObserver: unknown }).isRestrictedObserver = vi
    .fn()
    .mockResolvedValue(false);
  (server as unknown as { logConnectionAudit: unknown }).logConnectionAudit = vi.fn();
  server.attach(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
});

type Outcome =
  | { kind: 'close'; code: number; reason: string; opened: boolean }
  | { kind: 'http'; status: number };

function connect(path: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, ['bearer', JWT]);
    let opened = false;
    ws.on('open', () => {
      opened = true;
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ kind: 'http', status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on('close', (code, reason) =>
      resolve({ kind: 'close', code, reason: reason.toString(), opened })
    );
    ws.on('error', () => {
      /* followed by close or unexpected-response */
    });
  });
}

describe('LAW 1 - an invalid token is closed with 4401 + auth:<code>, after the handshake', () => {
  for (const path of [`/ws/table/${TABLE}`, '/ws/multi']) {
    it(`${path}: session_not_found -> 4401 auth:session_not_found`, async () => {
      verdict = { denied: 'invalid', code: 'session_not_found' };
      const out = await connect(path);
      expect(out).toEqual({
        kind: 'close',
        code: 4401,
        reason: 'auth:session_not_found',
        opened: true,
      });
    });

    it(`${path}: a legacy verifier returning null is still 4401 (never a silent 401)`, async () => {
      verdict = null;
      const out = await connect(path);
      expect(out.kind).toBe('close');
      if (out.kind === 'close') {
        expect(out.code).toBe(4401);
        expect(out.reason.startsWith('auth:')).toBe(true);
      }
    });
  }
});

describe('LAW 2 - an auth outage is a retryable 503, never a sign-out', () => {
  for (const path of [`/ws/table/${TABLE}`, '/ws/multi']) {
    it(`${path}: GoTrue unreachable -> HTTP 503 before the handshake`, async () => {
      verdict = { denied: 'unavailable', code: 'unreachable' };
      const out = await connect(path);
      expect(out).toEqual({ kind: 'http', status: 503 });
    });
  }
});

describe('a good token still opens (the fix did not break the door)', () => {
  it('/ws/multi opens with a valid verdict', async () => {
    verdict = { userId: 'u1' };
    const outcome = await new Promise<'open' | Outcome>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/multi`, ['bearer', JWT]);
      ws.on('open', () => {
        resolve('open');
        ws.close();
      });
      ws.on('unexpected-response', (_req, res) =>
        resolve({ kind: 'http', status: res.statusCode ?? 0 })
      );
      ws.on('close', (code, reason) =>
        resolve({ kind: 'close', code, reason: reason.toString(), opened: false })
      );
      ws.on('error', () => undefined);
    });
    expect(outcome).toBe('open');
  });
});
