/**
 * LAW: THE SAME ACTION APPLIES ONCE (Realtime programme Phase 3, 2026-09-05)
 *
 * `POST /action` moves real chips and is retried by the client on two
 * separate paths - a 429 ladder at 300/450/700ms and a 401-refresh retry
 * inside `engineFetch`. Both are safe only while the first attempt provably
 * did not run, and the 429 backoffs are chosen to clear the engine's own
 * 250ms window, so the one mechanism that would have collapsed a duplicate is
 * deliberately stepped over. Nothing in the request said "this is the same
 * intent" until this phase.
 *
 * PINS
 *   1. One key per intent, generated once per submitAction and carried by
 *      every attempt in that call - including the 401 retry.
 *   2. The key travels in the BODY. A header would fail CORS preflight
 *      against the engine's origin, and "widen CORS_HEADERS" is the wrong fix.
 *   3. A repeat of a key that ran does not reach the engine, and gets the
 *      first answer back.
 *   4. A key is remembered ONLY when the action reached the engine. A refusal
 *      (401 / 404 / 429) is never cached: the retry must be free to run.
 *   5. A rejection IS an answer and is remembered - a retry does not get a
 *      second chance to land into a pot that has moved on.
 *   6. One key with two different actions is refused, never replayed.
 *   7. No key at all is legal and behaves exactly as before, because bundles
 *      from before this shipped are still being served.
 *   8. There is no await between the lookup and the remember. That absence is
 *      what makes two simultaneous posts of one key impossible to both see
 *      'fresh', so it is pinned rather than assumed.
 *   9. Memory is bounded: a TTL and a hard ceiling, like every other in-engine
 *      map on the one core this runs on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_KEY_TTL_MS,
  MAX_ACTION_KEYS,
  actionFingerprint,
  actionKeysHeld,
  isValidActionKey,
  lookupAction,
  rememberAction,
  _resetActionIdempotencyForTests,
} from './actionIdempotency.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';
import { handleAction } from '../handlers/action.js';
import { __resetRateLimiterForTests } from './rateLimit.js';

const ROOT = join(__dirname, '..', '..', '..');
const HANDLER_SRC = readFileSync(join(ROOT, 'server', 'src', 'handlers', 'action.ts'), 'utf8');
const CLIENT_SRC = readFileSync(join(ROOT, 'src', 'services', 'GameServerAPI.ts'), 'utf8');

vi.mock('../http/auth.js', () => ({
  authenticateRequest: vi.fn(async () => ({ userId: 'u1' })),
}));
vi.mock('../http/body.js', () => ({
  readBody: vi.fn(async (req: { __body?: string }) => req.__body ?? '{}'),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

interface Sent {
  status: number;
  body: Record<string, unknown>;
}

function fakeReqRes(body: unknown): {
  req: unknown;
  res: unknown;
  sent: () => Sent;
} {
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    end: (b?: string) => {
      payload = b ?? '';
    },
  };
  return {
    req: { __body: JSON.stringify(body) },
    res,
    sent: () => ({ status, body: JSON.parse(payload || '{}') }),
  };
}

function engineThatCounts(): {
  engine: { handlePlayerAction: ReturnType<typeof vi.fn>; recordActionPerformance: () => void };
  deps: { gameServer: { getTableEngine: () => unknown } };
  calls: () => number;
} {
  const handlePlayerAction = vi.fn(() => ({ success: true }));
  const engine = { handlePlayerAction, recordActionPerformance: () => {} };
  return {
    engine,
    deps: { gameServer: { getTableEngine: () => engine } },
    calls: () => handlePlayerAction.mock.calls.length,
  };
}

beforeEach(() => {
  _resetActionIdempotencyForTests();
  __resetRateLimiterForTests();
});

describe('LAW 1/2 - one key per intent, in the body', () => {
  it('submitAction generates the key ONCE, outside the retry loop', () => {
    const fn = sliceMethod(CLIENT_SRC, 'export async function submitAction(');
    const code = blankNonCode(fn);
    expect(code).toContain('const idempotencyKey = newActionKey()');
    // Generated before the loop it is carried through: a key created inside
    // the loop would be a new key per retry, which is no protection at all.
    expect(code.indexOf('const idempotencyKey = newActionKey()')).toBeLessThan(
      code.indexOf('for (let attempt')
    );
    expect(code).toMatch(/JSON\.stringify\(\{[^}]*idempotencyKey[^}]*\}\)/);
  });

  it('the key is not sent as a request header, because CORS would refuse it', () => {
    const fn = sliceMethod(CLIENT_SRC, 'export async function submitAction(');
    expect(fn.toLowerCase()).not.toMatch(/['"]idempotency-key['"]\s*:/);
    // And the engine's allow-list is unchanged, so nobody "fixed" it that way.
    const respond = readFileSync(join(ROOT, 'server', 'src', 'http', 'respond.ts'), 'utf8');
    expect(respond).toContain("'Access-Control-Allow-Headers': 'Content-Type, Authorization'");
  });

  it("engineFetch's 401 retry re-sends the same body, so the key survives it", () => {
    const fn = sliceMethod(CLIENT_SRC, 'async function engineFetch(');
    // It re-uses `init` rather than rebuilding a body of its own, which is
    // the only reason the retry carries the same key.
    expect(fn).toContain('{ ...init, headers }');
  });
});

describe('LAW 3/5 - a repeat gets the first answer, engine untouched', () => {
  it('replays a success without calling the engine again', async () => {
    const { deps, calls } = engineThatCounts();
    const body = { tableId: 't1', action: 'raise', amount: 50, idempotencyKey: 'key-aaaaaaaa' };

    const first = fakeReqRes(body);
    await handleAction(first.req as never, first.res as never, deps as never);
    expect(first.sent().status).toBe(200);
    expect(calls()).toBe(1);

    const second = fakeReqRes(body);
    await handleAction(second.req as never, second.res as never, deps as never);
    expect(second.sent().status).toBe(200);
    expect(second.sent().body.replayed).toBe(true);
    expect(calls()).toBe(1); // the chips moved once
  });

  it('replays a REJECTION too - a retry is not a second chance', async () => {
    const handlePlayerAction = vi.fn(() => ({ success: false, error: 'Not your turn' }));
    const engine = { handlePlayerAction, recordActionPerformance: () => {} };
    const deps = { gameServer: { getTableEngine: () => engine } };
    const body = { tableId: 't1', action: 'call', idempotencyKey: 'key-bbbbbbbb' };

    const first = fakeReqRes(body);
    await handleAction(first.req as never, first.res as never, deps as never);
    expect(first.sent().status).toBe(400);

    const second = fakeReqRes(body);
    await handleAction(second.req as never, second.res as never, deps as never);
    expect(second.sent().status).toBe(400);
    expect(second.sent().body.error).toBe('Not your turn');
    expect(handlePlayerAction.mock.calls.length).toBe(1);
  });

  it('a replay is never rate limited: the lookup sits above checkRateLimit', () => {
    const fn = sliceMethod(HANDLER_SRC, 'export async function handleAction(');
    const code = blankNonCode(fn);
    expect(code.indexOf('lookupAction(')).toBeGreaterThan(0);
    expect(code.indexOf('lookupAction(')).toBeLessThan(code.indexOf('checkRateLimit('));
  });
});

describe('LAW 4 - a refusal is not an answer and is never remembered', () => {
  it('a 404 (no engine for the table yet) leaves the key free to run for real', async () => {
    const missing = { gameServer: { getTableEngine: () => null } };
    const body = { tableId: 't1', action: 'check', idempotencyKey: 'key-cccccccc' };

    const first = fakeReqRes(body);
    await handleAction(first.req as never, first.res as never, missing as never);
    expect(first.sent().status).toBe(404);
    expect(actionKeysHeld()).toBe(0);

    // The table rehydrates (the normal state for ~2 minutes after a restart)
    // and the very same key must now be able to act. The 250ms window is
    // cleared first: this case is about the key, not the limiter.
    __resetRateLimiterForTests();
    const { deps, calls } = engineThatCounts();
    const second = fakeReqRes(body);
    await handleAction(second.req as never, second.res as never, deps as never);
    expect(second.sent().status).toBe(200);
    expect(second.sent().body.replayed).toBeUndefined();
    expect(calls()).toBe(1);
  });

  it('rememberAction is called only after handlePlayerAction, on the one path', () => {
    const fn = sliceMethod(HANDLER_SRC, 'export async function handleAction(');
    const code = blankNonCode(fn);
    expect(code.split('rememberAction(').length - 1).toBe(1);
    expect(code.indexOf('rememberAction(')).toBeGreaterThan(code.indexOf('handlePlayerAction('));
  });
});

describe('LAW 6 - one key, one intent', () => {
  it('refuses the same key carrying a different action instead of replaying', async () => {
    const { deps, calls } = engineThatCounts();
    const key = 'key-dddddddd';

    const first = fakeReqRes({ tableId: 't1', action: 'fold', idempotencyKey: key });
    await handleAction(first.req as never, first.res as never, deps as never);
    expect(first.sent().status).toBe(200);

    const second = fakeReqRes({
      tableId: 't1',
      action: 'raise',
      amount: 200,
      idempotencyKey: key,
    });
    await handleAction(second.req as never, second.res as never, deps as never);
    expect(second.sent().status).toBe(409);
    expect(calls()).toBe(1);
    // And it did not hand back the fold's answer as if it were the raise's.
    expect(second.sent().body.success).toBe(false);
  });

  it('the key is scoped per player and per table', () => {
    const fp = actionFingerprint('call', undefined);
    rememberAction('u1', 't1', 'key-eeeeeeee', fp, 200, { success: true });
    expect(lookupAction('u2', 't1', 'key-eeeeeeee', fp).kind).toBe('fresh');
    expect(lookupAction('u1', 't2', 'key-eeeeeeee', fp).kind).toBe('fresh');
    expect(lookupAction('u1', 't1', 'key-eeeeeeee', fp).kind).toBe('replay');
  });

  it('the amount is part of the intent, so 50 and 500 are not the same raise', () => {
    expect(actionFingerprint('raise', 50)).not.toBe(actionFingerprint('raise', 500));
    expect(actionFingerprint('RAISE', 50)).toBe(actionFingerprint('raise', 50));
  });
});

describe('LAW 7 - no key is legal, and a bad key is loud', () => {
  it('an old bundle with no key still acts, exactly as before', async () => {
    const { deps, calls } = engineThatCounts();
    const a = fakeReqRes({ tableId: 't1', action: 'check' });
    await handleAction(a.req as never, a.res as never, deps as never);
    expect(a.sent().status).toBe(200);
    expect(actionKeysHeld()).toBe(0);

    __resetRateLimiterForTests();
    const b = fakeReqRes({ tableId: 't1', action: 'check' });
    await handleAction(b.req as never, b.res as never, deps as never);
    expect(b.sent().status).toBe(200);
    expect(calls()).toBe(2); // two keyless posts are two actions, as they always were
  });

  it('a malformed key is refused rather than silently ignored', async () => {
    const { deps, calls } = engineThatCounts();
    const bad = fakeReqRes({ tableId: 't1', action: 'check', idempotencyKey: 'x' });
    await handleAction(bad.req as never, bad.res as never, deps as never);
    expect(bad.sent().status).toBe(400);
    expect(bad.sent().body.error).toBe('Invalid action key');
    expect(calls()).toBe(0);
  });

  it('the key shape is bounded, so it cannot be used to grow the map', () => {
    expect(isValidActionKey('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidActionKey('x'.repeat(101))).toBe(false);
    expect(isValidActionKey('has spaces')).toBe(false);
    expect(isValidActionKey('{"a":1}')).toBe(false);
    expect(isValidActionKey(42)).toBe(false);
    expect(isValidActionKey(null)).toBe(false);
  });
});

describe('LAW 8 - nothing awaits between the lookup and the remember', () => {
  it('the window that makes two simultaneous posts impossible is still closed', () => {
    const fn = sliceMethod(HANDLER_SRC, 'export async function handleAction(');
    const code = blankNonCode(fn);
    const from = code.indexOf('lookupAction(');
    const to = code.indexOf('rememberAction(');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    // An await in here would let a second request observe 'fresh' while the
    // first was still running, and both would move chips.
    expect(code.slice(from, to)).not.toContain('await');
  });
});

describe('LAW 9 - bounded memory and a TTL', () => {
  it('forgets a key once its TTL has passed', () => {
    const fp = actionFingerprint('call', undefined);
    const t0 = 1_000_000;
    rememberAction('u1', 't1', 'key-ffffffff', fp, 200, { success: true }, t0);
    expect(lookupAction('u1', 't1', 'key-ffffffff', fp, t0 + ACTION_KEY_TTL_MS - 1).kind).toBe(
      'replay'
    );
    expect(lookupAction('u1', 't1', 'key-ffffffff', fp, t0 + ACTION_KEY_TTL_MS + 1).kind).toBe(
      'fresh'
    );
  });

  it('the TTL outlives every retry of one intent by a wide margin', () => {
    // The client ladder is 300 + 450 + 700ms plus one 401 refresh.
    expect(ACTION_KEY_TTL_MS).toBeGreaterThan(10 * (300 + 450 + 700));
  });

  it('evicts rather than grows past the ceiling', () => {
    const fp = actionFingerprint('call', undefined);
    for (let i = 0; i < MAX_ACTION_KEYS + 100; i++) {
      rememberAction('u1', 't1', `key-${String(i).padStart(8, '0')}`, fp, 200, { success: true });
    }
    expect(actionKeysHeld()).toBeLessThanOrEqual(MAX_ACTION_KEYS);
  });
});
