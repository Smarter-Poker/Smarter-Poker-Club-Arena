import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as realDelay } from 'node:timers/promises';
import type { Page, Response as BrowserResponse } from '@playwright/test';
import {
  matchesGameCreationRead,
  waitForGameCreationAuthority,
} from '../e2e/support/gameCreationReadiness';

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/supabase', () => ({
  get supabase() {
    return state.client;
  },
  getAuthUser: async () => ({ data: { user: null }, error: null }),
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: (value: unknown) => unknown) =>
    select({ user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));
vi.mock('../../src/components/cash/CashGameCreateFlow', () => ({ default: () => null }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: () => () => {} },
}));
import GameCreationGuard from '../../src/components/auth/GameCreationGuard';
import TableConfigPage from '../../src/pages/TableConfigPage';

const CLUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const allowed = { allowed: true, union_id: null, reason: 'ok' };
const reply = (
  body: unknown,
  status = 200,
  clubId = CLUB,
  method = 'POST',
  path = 'fn_game_creation_access'
): BrowserResponse =>
  ({
    url: () => `http://fixture/rest/v1/rpc/${path}`,
    request: () => ({ method: () => method, postDataJSON: () => ({ p_club_id: clubId }) }),
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
  }) as BrowserResponse;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('waits for the actual guarded page read after the former five-second assertion window', async () => {
  let held: ServerResponse | undefined;
  const requests: string[] = [];
  let observer: ((response: BrowserResponse) => void) | undefined;
  let permissionReads = 0;
  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/rest/v1/rpc/fn_game_creation_access') {
      ++permissionReads;
      if (permissionReads === 1) held = res;
      else res.end(JSON.stringify(allowed));
    } else if (req.url === '/rest/v1/rpc/fn_platform_capabilities' || req.method === 'GET') {
      res.end('[]');
    } else res.writeHead(400).end('{"message":"Unexpected fixture request"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const nativeFetch = globalThis.fetch.bind(globalThis);
  state.client = createClient(`http://127.0.0.1:${address.port}`, 'local-fixture-only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const response = await nativeFetch(input, init);
        const body = await response.text();
        const observed = {
          url: () => String(input),
          request: () => ({
            method: () => init?.method || 'GET',
            postDataJSON: () => JSON.parse(String(init?.body)),
          }),
          ok: () => response.ok,
          status: () => response.status,
          json: async () => JSON.parse(body),
        } as BrowserResponse;
        observer?.(observed);
        return new Response(body, { status: response.status, headers: response.headers });
      },
    },
  });
  const page = {
    waitForResponse: (
      predicate: (response: BrowserResponse) => boolean,
      options: { timeout: number }
    ) =>
      new Promise<BrowserResponse>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Permission observation deadline')),
          options.timeout
        );
        observer = (response) => {
          if (predicate(response)) {
            clearTimeout(timer);
            resolve(response);
          }
        };
      }),
  } as unknown as Pick<Page, 'waitForResponse'>;
  const eventually = async (assert: () => void) => {
    let error: unknown;
    for (let attempt = 0; attempt < 100; ++attempt) {
      await act(async () => {
        await realDelay(5);
      });
      try {
        assert();
        return;
      } catch (cause) {
        error = cause;
      }
    }
    throw error;
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let confirmed = false;
    let readinessError: unknown;
    const ready = waitForGameCreationAuthority(page, CLUB, 90_000).then(
      () => {
        confirmed = true;
      },
      (error) => {
        readinessError = error;
      }
    );
    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB}/create-table/nlh`]}>
        <Routes>
          <Route
            path="/clubs/:clubId/create-table/:gameType"
            element={
              <GameCreationGuard>
                <TableConfigPage />
              </GameCreationGuard>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    await eventually(() => expect(held).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(screen.queryByRole('button', { name: 'MTT', exact: true })).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading content' })).toBeVisible();
    expect(confirmed).toBe(false);
    await act(async () => {
      held!.end(JSON.stringify(allowed));
      await realDelay(10);
    });
    await eventually(() =>
      expect(screen.getByRole('button', { name: 'MTT', exact: true })).toBeVisible()
    );
    await ready;
    if (readinessError) throw readinessError;
    expect(confirmed).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'MTT', exact: true }));
    expect(screen.getByRole('button', { name: 'MTT', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      requests.every(
        (request) =>
          request.startsWith('GET ') ||
          /^POST \/rest\/v1\/rpc\/fn_(game_creation_access|platform_capabilities)$/.test(request)
      )
    ).toBe(true);
  } finally {
    cleanup();
    held?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
  }
});

it.each([
  [reply(allowed, 503), 'HTTP 503'],
  [
    reply({ allowed: false, union_id: null, reason: 'not_owner_or_admin' }),
    'denied: not_owner_or_admin',
  ],
  [reply(null), 'malformed data'],
  [reply([]), 'malformed data'],
  [reply({ ...allowed, allowed: 'true' }), 'did not confirm'],
  [reply({ ...allowed, union_id: CLUB }), 'did not confirm'],
  [reply({ allowed: true, reason: 'ok' }), 'did not confirm'],
  [reply({ ...allowed, reason: 'check_failed' }), 'did not confirm'],
])(
  'never treats a completed bad permission response as route readiness',
  async (response, message) => {
    const page = { waitForResponse: async () => response } as unknown as Pick<
      Page,
      'waitForResponse'
    >;
    await expect(waitForGameCreationAuthority(page, CLUB, 90_000)).rejects.toThrow(message);
  }
);

it('matches only the exact route read and refuses malformed request bodies', () => {
  expect(matchesGameCreationRead(reply(allowed), CLUB)).toBe(true);
  expect(matchesGameCreationRead(reply(allowed, 200, 'foreign-club'), CLUB)).toBe(false);
  expect(matchesGameCreationRead(reply(allowed, 200, CLUB, 'GET'), CLUB)).toBe(false);
  expect(matchesGameCreationRead(reply(allowed, 200, CLUB, 'POST', 'other'), CLUB)).toBe(false);
  const malformed = reply(allowed);
  malformed.request = () =>
    ({
      method: () => 'POST',
      postDataJSON: () => {
        throw new Error('Bad request JSON');
      },
    }) as never;
  expect(matchesGameCreationRead(malformed, CLUB)).toBe(false);
});

it('reports an unreadable permission response and preserves the bounded observer failure', async () => {
  const invalidJson = reply(allowed);
  invalidJson.json = async () => {
    throw new Error('Invalid JSON');
  };
  await expect(
    waitForGameCreationAuthority(
      { waitForResponse: async () => invalidJson } as unknown as Pick<Page, 'waitForResponse'>,
      CLUB,
      90_000
    )
  ).rejects.toThrow('invalid JSON');
  const timedOut = {
    waitForResponse: vi.fn(async () => {
      throw new Error('Permission read timed out');
    }),
  } as unknown as Pick<Page, 'waitForResponse'>;
  await expect(waitForGameCreationAuthority(timedOut, CLUB, 90_000)).rejects.toThrow(
    'Permission read timed out'
  );
  expect(timedOut.waitForResponse).toHaveBeenCalledWith(expect.any(Function), { timeout: 90_000 });
});

it('keeps the production consumer wired before its unchanged control assertion and catalog checks', () => {
  const source = readFileSync('tests/e2e/routes/catalog-observers.spec.ts', 'utf8');
  const permission = source.indexOf(
    'const permission = waitForGameCreationAuthority(page, CLUB_ID, 90_000)'
  );
  const awaited = source.indexOf('await Promise.all([', permission);
  const control = source.indexOf(
    "await expect(page.getByRole('button', { name: 'MTT', exact: true })).toBeVisible()",
    awaited
  );
  expect(permission).toBeGreaterThan(0);
  expect(awaited).toBeGreaterThan(permission);
  expect(control).toBeGreaterThan(awaited);
  expect(source).toContain('timeout: 150_000');
  const nextRead = source.indexOf("const nextRead = read(page, 'table_templates', match)");
  const lifecycleRefresh = source.indexOf(
    "window.dispatchEvent(new Event('online'))",
    nextRead
  );
  const awaitNext = source.indexOf('const next = await nextRead', lifecycleRefresh);
  expect(nextRead).toBeGreaterThan(control);
  expect(lifecycleRefresh).toBeGreaterThan(nextRead);
  expect(awaitNext).toBeGreaterThan(lifecycleRefresh);
  expect(source).toContain("await expect(draft).toHaveValue('Unsubmitted Catalog Check')");
});

it('does not repeat standalone authority inside an already guarded table config route', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const page = readFileSync('src/pages/TableConfigPage.tsx', 'utf8');
  expect(app).toContain('<TableConfigPage accessPrevalidated />');
  expect(page).toContain('accessPrevalidated ? PREVALIDATED_STANDALONE_ACCESS : null');
  expect(page).toContain('if (accessPrevalidated)');
});
