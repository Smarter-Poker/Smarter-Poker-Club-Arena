/**
 * A WAKE REFUSAL IS NOT A SLOW ENGINE (Create A Club Phase 2, 2026-09-22).
 *
 * `getTableState` answers null for a 403, a 404, a 503 and a dropped request
 * alike. That was right for its callers (a resync, a recovery read) and wrong
 * for Start in the New Cash Game flow, which has to tell a table that is still
 * waking from an engine that has ruled this person may not watch it: a union
 * operator may CREATE a game (fn_can_create_games) without being a member of
 * any club the engine admits to its table (server TableViewerAccess).
 *
 * `wakeTable` makes the same read and keeps the verdict. This pins:
 *   - 200 with a body is awake; 403 with one of the engine's two access codes
 *     is refused WITH that code; everything else is "not awake", which is
 *     exactly what getTableState's null always meant;
 *   - getTableState's own answers did not move, for any status;
 *   - the two codes are the engine's (server/src/handlers/state.ts) and the
 *     socket's (MUX_ACCESS_REFUSAL_CODES), so the HTTP and WS halves cannot
 *     drift apart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/lib/authToken', () => ({
  getFreshAccessToken: async () =>
    JSON.parse(localStorage.getItem('smarter-poker-auth')!).access_token,
}));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('../src/utils/errorReporter', () => ({ reportError }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TABLE_VIEW_REFUSAL_CODES, getTableState, wakeTable } from '../src/services/GameServerAPI';
import { MUX_ACCESS_REFUSAL_CODES } from '../src/services/EngineSocketMux';

const reply = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
    return body;
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem(
    'smarter-poker-auth',
    JSON.stringify({
      access_token: `e30.${btoa(JSON.stringify({ sub: 'user-1', session_id: 'login-1', exp: 4102444800 }))}.sig`,
    })
  );
});

describe('wakeTable keeps the verdict getTableState throws away', () => {
  it('reads the same authenticated /state endpoint', async () => {
    mockFetch.mockResolvedValue(reply(200, { table_id: 't1', stage: 'idle', players: [] }));
    await wakeTable('t1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/state\/t1$/);
    expect(new Headers(init.headers).get('Authorization')).toMatch(/^Bearer /);
  });

  it('200 with a state is awake, and carries the state', async () => {
    const state = { table_id: 't1', stage: 'idle', players: [] };
    mockFetch.mockResolvedValue(reply(200, state));
    expect(await wakeTable('t1')).toEqual({ status: 'awake', state });
  });

  it.each([...TABLE_VIEW_REFUSAL_CODES])('403 %s is refused, with that code', async (code) => {
    mockFetch.mockResolvedValue(
      reply(403, { success: false, code, error: 'refused', club_id: 'club-1' })
    );
    expect(await wakeTable('t1')).toEqual({ status: 'refused', code });
  });

  it.each([
    ['a 403 naming a code this client does not know', reply(403, { code: 'SOMETHING_NEW' })],
    ['a 403 with no body', reply(403)],
    ['a 403 whose body is not an object', reply(403, 'Forbidden')],
    ['the table row not found', reply(404, { error: 'Table not found' })],
    ['the engine not built yet', reply(404, { error: 'Table engine not found' })],
    ['an access check the engine could not make', reply(503, { error: 'Unable to verify' })],
    ['a server error', reply(500)],
    ['a 200 with no state in it', reply(200, null)],
  ])('%s is not awake yet, never a verdict', async (_label, response) => {
    mockFetch.mockResolvedValue(response);
    expect(await wakeTable('t1')).toEqual({ status: 'not_awake' });
  });

  it('a dropped request is not awake, reported, and never thrown', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(wakeTable('t1')).resolves.toEqual({ status: 'not_awake' });
    expect(reportError).toHaveBeenCalledWith(expect.any(TypeError), 'GameServerAPI.wakeTable');
  });
});

describe("getTableState's answers did not move", () => {
  it.each([
    [200, { table_id: 't1' }, { table_id: 't1' }],
    [403, { code: 'CLUB_MEMBERSHIP_REQUIRED' }, null],
    [403, { code: 'OBSERVERS_RESTRICTED' }, null],
    [404, { error: 'Table engine not found' }, null],
    [503, { error: 'Unable to verify table access' }, null],
  ])('HTTP %s still answers %j -> %j', async (status, body, expected) => {
    mockFetch.mockResolvedValue(reply(status, body));
    expect(await getTableState('t1')).toEqual(expected);
  });

  it('a dropped request is still null', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await getTableState('t1')).toBeNull();
  });
});

describe('one vocabulary for the refusal, on both transports', () => {
  it("the HTTP codes are the socket's codes", () => {
    expect([...TABLE_VIEW_REFUSAL_CODES].sort()).toEqual([...MUX_ACCESS_REFUSAL_CODES].sort());
  });

  it('and both are what the engine actually sends', () => {
    const handler = readFileSync(join(__dirname, '..', 'server/src/handlers/state.ts'), 'utf8');
    const socket = readFileSync(
      join(__dirname, '..', 'server/src/transport/EngineWebSocketServer.ts'),
      'utf8'
    );
    for (const code of TABLE_VIEW_REFUSAL_CODES) {
      expect(handler).toContain(`code: '${code}'`);
      expect(socket).toContain(`'${code}'`);
    }
    // The handler answers both with 403, which is the status wakeTable reads.
    expect(handler.match(/sendJSON\(res, 403, \{/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
