import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

const key = 'fixture-only-recovery-key';
let createRouter: (typeof import('./router.js'))['createRouter'];
beforeAll(async () => {
  vi.stubEnv('INTERNAL_API_KEY', key);
  vi.resetModules();
  ({ createRouter } = await import('./router.js'));
});
afterAll(() => vi.unstubAllEnvs());

async function request(overrides: Record<string, unknown> = {}, outcome?: () => Promise<unknown>) {
  const {
    peer = '127.0.0.1',
    body = { announcedAt: 123 },
    method = 'POST',
    headers = { authorization: `Bearer ${key}` },
  } = overrides;
  const owner = vi.fn(outcome || (async () => ({ status: 'accepted', announcedAt: 123 })));
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  Object.assign(req, {
    url: '/internal/maintenance-recovery-window',
    method,
    headers,
    socket: { remoteAddress: peer },
  });
  const result = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    setHeader: (name: string, value: unknown) => {
      result.headers[name.toLowerCase()] = value;
    },
    writeHead: (status: number) => {
      result.status = status;
    },
    end: (body: string) => {
      result.body = body;
    },
  } as unknown as ServerResponse;
  await createRouter({ gameServer: { requestMaintenanceRecoveryWindow: owner } } as any)(req, res);
  return { ...result, owner };
}

describe('only the authenticated local release owner requests maintenance recovery', () => {
  it.each([
    { headers: {} },
    { headers: { authorization: 'Bearer wrong' } },
    { peer: '203.0.113.1' },
    { headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': '127.0.0.1' } },
    { headers: { authorization: `Bearer ${key}`, forwarded: 'for=127.0.0.1' } },
  ])('rejects unauthorized transport %j before mutation', async (input) => {
    const result = await request(input);
    expect(result.status).toBe(401);
    expect(result.owner).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { announcedAt: '123' },
    { announcedAt: 1.2 },
    { announcedAt: 123, extend: true },
  ])('rejects malformed identity %j', async (body) => {
    const result = await request({ body });
    expect(result.status).toBe(400);
    expect(result.owner).not.toHaveBeenCalled();
  });
  it('dispatches the unchanged timestamp once and prevents caching', async () => {
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.owner).toHaveBeenCalledOnce();
    expect(result.owner).toHaveBeenCalledWith(123);
  });
  it('returns unknown rather than success when the owning write loses acknowledgment', async () => {
    const result = await request({}, async () => {
      throw new Error('response lost');
    });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).error).toBe('Recovery window outcome unknown');
    expect(result.owner).toHaveBeenCalledOnce();
  });
  it('refuses GET without mutating the maintenance owner', async () => {
    const result = await request({ method: 'GET' });
    expect(result.status).toBe(405);
    expect(result.owner).not.toHaveBeenCalled();
  });
});
