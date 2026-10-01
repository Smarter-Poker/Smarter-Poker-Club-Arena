/**
 * A SIGNED-IN PLAYER WITH NOTHING BEHIND THEM BUT THIS FILE.
 *
 * The stale-client specs need a Diamond player standing in the lobby, at a
 * table and in the cashier, whose session can expire, fail to refresh or be
 * revoked on cue. Nothing real may be touched to get there (Phase 11 rules: no
 * real accounts, no production engine), so every answer comes from here:
 *
 *   - the session is a local one: a well-formed JWT for a fixture id, in the
 *     shared `smarter-poker-auth` key, seeded once per tab;
 *   - Supabase (the build's placeholder https://example.supabase.co) is
 *     answered per call - GoTrue's user and token endpoints, every RPC and
 *     every table read - with PostgREST's own shapes, and every call logged;
 *   - every WebSocket (Realtime, the engine) is answered here, never opened;
 *   - the engine's /health and /heartbeat are answered here too (the table's
 *     heartbeat is how a revoked session is noticed mid-session), and every
 *     other engine call is refused locally;
 *   - every other host is aborted, so no request leaves this machine.
 */
import type { Page, Request, Route } from '@playwright/test';

export const PLAYER = '5ca1ab1e-0000-4000-8000-000000000011';
export const SESSION = '5e551011-0000-4000-8000-000000000022';
export const DIAMOND_ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';
/** A Diamond cash table id (production's, 2026-09-30); its row is answered here. */
export const DIAMOND_TABLE = '415fd455-e37c-4b02-8c1d-586c246d6743';
const SUPABASE = 'example.supabase.co';

type Json = unknown;
export interface Answer {
  status?: number;
  body?: Json;
  headers?: Record<string, string>;
}

export interface Backend {
  /** GoTrue's answer to /user: the session is alive, or revoked. */
  session: 'alive' | 'revoked';
  /** GoTrue's answer to a refresh: a new token, a revoked one, or no answer. */
  refresh: 'ok' | 'revoked' | 'offline';
  /** RPC answers by function name; the default is PostgREST's `null`. */
  rpc: Record<string, (args: Record<string, unknown>) => Answer>;
  /** Table reads by table name; the default is no rows. */
  tables: Record<string, Json[]>;
  /** How the engine socket answers; the default closes it as a lost link. */
  engineSocket: 'lost' | 'auth-refused';
  /** Whether the engine's health and heartbeat are answered here (else aborted). */
  engineHttp: 'answered' | 'blocked';
  /** Every Supabase call, in order: "rpc fn_x", "GET profiles", "POST /auth/v1/token". */
  calls: string[];
}

function b64url(value: Json): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function fakeJwt(claims: Record<string, Json>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.fixture-signature`;
}

function sessionFor(expiresAt: number): Record<string, Json> {
  return {
    access_token: fakeJwt({
      sub: PLAYER,
      role: 'authenticated',
      aud: 'authenticated',
      session_id: SESSION,
      email: 'stale-client-fixture@example.invalid',
      exp: expiresAt,
    }),
    refresh_token: 'stale-client-fixture-refresh',
    token_type: 'bearer',
    expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    expires_at: expiresAt,
    user: {
      id: PLAYER,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'stale-client-fixture@example.invalid',
      app_metadata: { provider: 'email' },
      user_metadata: { username: 'fixture' },
      created_at: '2026-01-01T00:00:00Z',
    },
  };
}

/** The Diamond Arena as fn_poker_arena_context answers a player today. */
export const DIAMOND_CONTEXT = {
  arena: { id: DIAMOND_ARENA, asset: 'diamonds', is_platform: true, union_id: null },
  member: true,
  role: 'player',
  cashGamesEnabled: false,
  tournamentsEnabled: false,
};

export function newBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    session: 'alive',
    refresh: 'ok',
    rpc: {
      fn_poker_arena_context: () => ({ body: DIAMOND_CONTEXT }),
    },
    tables: {
      tables: [
        {
          id: DIAMOND_TABLE,
          club_id: DIAMOND_ARENA,
          union_id: null,
          tournament_id: null,
          name: 'Diamond NLH 1/2',
          game_variant: 'nlh',
          game_type: 'cash',
          status: 'waiting',
          small_blind: 1,
          big_blind: 2,
          min_buy_in: 40,
          max_buy_in: 200,
          max_players: 6,
          current_players: 0,
          is_deleted: false,
          created_at: '2026-09-29T00:00:00Z',
        },
      ],
      profiles: [
        {
          id: PLAYER,
          username: 'fixture',
          alias: 'Fixture',
          full_name: 'Stale Client Fixture',
          role: 'user',
          diamonds: 812,
          diamond_balance: 812,
          club_arena_tos_accepted_at: '2026-09-01T00:00:00Z',
          avatar_url: '/hub/club-arena/default-avatar.png',
          arena_avatar_url: '/hub/club-arena/default-avatar.png',
        },
      ],
      clubs: [
        {
          id: DIAMOND_ARENA,
          slug: 'diamond-arena',
          name: 'Diamond Arena',
          asset: 'diamonds',
          is_platform: true,
          is_union: false,
          union_id: null,
          owner_id: null,
          member_count: 0,
          created_at: '2026-09-08T00:00:00Z',
        },
      ],
    },
    engineSocket: 'lost',
    engineHttp: 'blocked',
    calls: [],
    ...overrides,
  };
}

function fulfil(route: Route, answer: Answer): Promise<void> {
  return route.fulfill({
    status: answer.status ?? 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', ...answer.headers },
    body: answer.body === undefined ? 'null' : JSON.stringify(answer.body),
  });
}

async function answerSupabase(backend: Backend, route: Route, request: Request): Promise<void> {
  const url = new URL(request.url());
  const method = request.method();
  if (method === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,HEAD,OPTIONS',
      },
    });
  }
  if (url.pathname.startsWith('/auth/v1/')) {
    backend.calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/auth/v1/user') {
      return backend.session === 'alive'
        ? fulfil(route, { body: sessionFor(0).user })
        : fulfil(route, {
            status: 403,
            body: {
              code: 'session_not_found',
              message: 'Session from session_id claim in JWT does not exist',
            },
          });
    }
    if (url.pathname === '/auth/v1/token') {
      if (backend.refresh === 'offline') return route.abort('internetdisconnected');
      if (backend.refresh === 'revoked')
        return fulfil(route, {
          status: 400,
          body: {
            code: 'refresh_token_not_found',
            message: 'Invalid Refresh Token: Refresh Token Not Found',
          },
        });
      return fulfil(route, { body: sessionFor(Math.floor(Date.now() / 1000) + 3600) });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    return fulfil(route, { body: {} });
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.slice('/rest/v1/rpc/'.length);
    backend.calls.push(`rpc ${fn}`);
    let args: Record<string, unknown> = {};
    try {
      args = request.postDataJSON() ?? {};
    } catch {
      /* GET rpc: arguments are in the query string */
    }
    return fulfil(route, backend.rpc[fn]?.(args) ?? { body: null });
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.slice('/rest/v1/'.length);
    backend.calls.push(`${method} ${table}`);
    const rows = backend.tables[table] ?? [];
    if (method === 'HEAD')
      return route.fulfill({ status: 200, headers: { 'content-range': `*/${rows.length}` } });
    if (method !== 'GET') return fulfil(route, { status: 201, body: rows });
    if ((request.headers()['accept'] ?? '').includes('vnd.pgrst.object')) {
      return rows.length === 1
        ? fulfil(route, { body: rows[0] })
        : fulfil(route, {
            status: 406,
            body: {
              code: 'PGRST116',
              message: 'JSON object requested, multiple (or no) rows returned',
            },
          });
    }
    return fulfil(route, {
      body: rows,
      headers: { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` },
    });
  }
  backend.calls.push(`${method} ${url.pathname}`);
  return fulfil(route, {
    status: 404,
    body: { message: 'not answered by the stale-client backend' },
  });
}

/**
 * The engine, answered locally: healthy, and accepting this player's
 * heartbeats while the session lives. A revoked session's heartbeat is
 * refused as the engine refuses it (HTTP 401), before it runs.
 */
async function answerEngine(backend: Backend, route: Route, request: Request): Promise<void> {
  const url = new URL(request.url());
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  backend.calls.push(`engine ${request.method()} ${url.pathname}`);
  if (url.pathname === '/health')
    return fulfil(route, { body: { status: 'ok', liveness: 'ok' }, headers: cors });
  if (url.pathname === '/heartbeat')
    return backend.session === 'alive'
      ? fulfil(route, { body: { success: true }, headers: cors })
      : fulfil(route, {
          status: 401,
          body: { success: false, error: 'auth:session_not_found' },
          headers: cors,
        });
  return fulfil(route, { status: 404, body: { success: false }, headers: cors });
}

/**
 * Put a signed-in player in this page. `expired` seeds a session whose access
 * token has already expired, so the first thing the app must do is refresh.
 */
export async function signIn(
  page: Page,
  backend: Backend,
  opts: { expired?: boolean } = {}
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const session = sessionFor(opts.expired ? now - 3600 : now + 7 * 24 * 3600);
  await page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('stale-client-seeded')) return;
      sessionStorage.setItem('stale-client-seeded', '1');
      localStorage.setItem(key, value);
      // A device that has read the Poker Arena disclaimer before.
      localStorage.setItem('club_arena_welcome_accepted', 'true');
    },
    ['smarter-poker-auth', JSON.stringify(session)] as const
  );
  await page.routeWebSocket(/.*/, (ws) => {
    if (backend.engineSocket === 'auth-refused' && !ws.url().includes(SUPABASE)) {
      ws.close({ code: 4401, reason: 'auth:session_not_found' });
      return;
    }
    ws.close({ code: 1001, reason: 'stale-client suite: no socket leaves this machine' });
  });
  await page.route(
    (url) => url.hostname !== '127.0.0.1',
    (route, request) => {
      const host = new URL(request.url()).hostname;
      if (host === SUPABASE) return answerSupabase(backend, route, request);
      if (host === 'engine.smarter.poker' && backend.engineHttp === 'answered')
        return answerEngine(backend, route, request);
      return route.abort('blockedbyclient');
    }
  );
}
