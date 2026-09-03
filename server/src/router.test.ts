import { describe, it, expect } from 'vitest';

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
    writeHead: (code: number) => { captured.statusCode = code; return res; },
    setHeader: () => res,
    end: (chunk?: string) => { if (chunk) captured.body += chunk; },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('the router answers /health with a query string', () => {
  const gameServer = {
    getStatus: () => ({ liveness: 'ok', probe: 'cache-busted' }),
    getPrometheusMetrics: () => '',
  };
  const router = createRouter({ gameServer } as never);

  it.each(['/health', '/health?cb=1788402501855', '/?cb=2'])('%s is the health route', async (target) => {
    const { res, captured } = fakeRes();
    await router({ method: 'GET', url: target, headers: {} } as unknown as IncomingMessage, res);
    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ probe: 'cache-busted' });
  });

  it('an unknown path with a query is still a 404', async () => {
    const { res, captured } = fakeRes();
    await router({ method: 'GET', url: '/nope?cb=1', headers: {} } as unknown as IncomingMessage, res);
    expect(captured.statusCode).toBe(404);
  });
});
