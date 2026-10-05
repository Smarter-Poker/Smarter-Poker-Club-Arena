import { describe, it, expect, vi } from 'vitest';

/**
 * The router matches on the PATH, not the whole request target (2026-09-03).
 * `/health?cb=...` used to fall through to the 404 at the bottom of the
 * router; spin-sweep, both watchdogs and anyone cache-busting per the
 * estate's own advice read "engine unreachable" from a healthy engine.
 */
import { createRouter } from './router.js';
import type { IncomingMessage, ServerResponse } from 'http';

function fakeRes() {
  const captured: { statusCode?: number; body: string } = { body: '' };
  const res = {
    writeHead: (code: number) => {
      captured.statusCode = code;
      return res;
    },
    setHeader: () => res,
    end: (chunk?: string) => {
      if (chunk) captured.body += chunk;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('the router answers /health with a query string', () => {
  const gameServer = {
    getStatus: () => ({
      liveness: 'ok',
      status: 'ok',
      dealerPrerequisitesReady: true,
      liveHorseDecision: { phase: 'ready' },
      probe: 'cache-busted',
    }),
    getPrometheusMetrics: () => '',
  };
  const router = createRouter({ gameServer } as never);

  it.each(['/health', '/health?cb=1788402501855', '/?cb=2'])(
    '%s is the health route',
    async (target) => {
      const { res, captured } = fakeRes();
      await router({ method: 'GET', url: target, headers: {} } as unknown as IncomingMessage, res);
      expect(captured.statusCode).toBe(200);
      expect(JSON.parse(captured.body)).toMatchObject({ probe: 'cache-busted' });
    }
  );

  it('an unknown path with a query is still a 404', async () => {
    const { res, captured } = fakeRes();
    await router(
      { method: 'GET', url: '/nope?cb=1', headers: {} } as unknown as IncomingMessage,
      res
    );
    expect(captured.statusCode).toBe(404);
  });

  it('carries explicit table scope through the real router and rejects an unbounded request', async () => {
    const tableId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const getStatus = vi.fn(gameServer.getStatus);
    const scoped = createRouter({ gameServer: { ...gameServer, getStatus } } as never);
    const { res, captured } = fakeRes();
    await scoped(
      {
        method: 'GET',
        url: `/health?cb=1&liveness_table_ids=${tableId}`,
        headers: {},
      } as IncomingMessage,
      res
    );
    expect(captured.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith({ kind: 'tables', tableIds: [tableId] });
    const invalid = fakeRes();
    await scoped(
      { method: 'GET', url: '/health?liveness_all=true', headers: {} } as IncomingMessage,
      invalid.res
    );
    expect(invalid.captured.statusCode).toBe(400);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});

/**
 * ONE REQUEST CANNOT RESTART THE ENGINE (launch audit 2026-10-05).
 *
 * The router is handed straight to `http.createServer`, which does not await
 * it. A handler that throws became an unhandledRejection, and index.ts treats
 * that as fatal: drain, restart, every hand in flight voided. The router now
 * answers 500 and resolves.
 */
describe('a handler that throws is a 500, never a rejected listener', () => {
  it('answers 500 and resolves when the handler throws before writing', async () => {
    const router = createRouter({
      gameServer: {
        getStatus: () => {
          throw new Error('boom');
        },
        getPrometheusMetrics: () => {
          throw new Error('boom');
        },
      },
    } as never);
    const { res, captured } = fakeRes();
    await expect(
      router({ method: 'GET', url: '/metrics', headers: {} } as unknown as IncomingMessage, res)
    ).resolves.toBeUndefined();
    expect(captured.statusCode).toBe(500);
    expect(JSON.parse(captured.body)).toEqual({ error: 'Internal Server Error' });
  });

  it('destroys the response instead of writing twice when headers already went out', async () => {
    const router = createRouter({
      gameServer: {
        getPrometheusMetrics: () => {
          throw new Error('boom');
        },
      },
    } as never);
    const destroy = vi.fn();
    const res = {
      headersSent: true,
      writeHead: vi.fn(),
      setHeader: vi.fn(),
      end: vi.fn(),
      destroy,
    } as unknown as ServerResponse;
    await expect(
      router({ method: 'GET', url: '/metrics', headers: {} } as unknown as IncomingMessage, res)
    ).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(
      (res as unknown as { writeHead: ReturnType<typeof vi.fn> }).writeHead
    ).not.toHaveBeenCalled();
  });
});
