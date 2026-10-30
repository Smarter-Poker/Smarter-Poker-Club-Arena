import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTournamentAbortBoundary } from './tournamentAbortBoundary.js';
const operationId = '11111111-1111-4111-8111-111111111111';
const tournamentId = '22222222-2222-4222-8222-222222222222';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function request(
  token: string,
  body: unknown,
  invoke = vi.fn(async () => ({ state: 'acknowledged' }))
) {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'isolated-service-key');
  const req = Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const result = { status: 0, body: '' };
  const res = {
    setHeader: vi.fn(),
    writeHead: (status: number) => {
      result.status = status;
    },
    end: (value: string) => {
      result.body = value;
    },
  };
  await handleTournamentAbortBoundary(req as any, res as any, {
    gameServer: { acknowledgeTournamentAbortBoundary: invoke },
  });
  return { ...result, invoke };
}
describe('only the exact configured service can ask an original abort owner', () => {
  it('rejects a forged service-role JWT and missing configuration', async () => {
    const r = await request('header.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake', {
      operationId,
      tournamentId,
    });
    expect(r.status).toBe(401);
    expect(r.invoke).not.toHaveBeenCalled();
  });
  it('rejects extra money or engine identity fields before dispatch', async () => {
    const r = await request('isolated-service-key', {
      operationId,
      tournamentId,
      refundAmount: 10,
    });
    expect(r.status).toBe(400);
    expect(r.invoke).not.toHaveBeenCalled();
  });
  it('dispatches only exact operation and tournament identities', async () => {
    const r = await request('isolated-service-key', { operationId, tournamentId });
    expect(r.status).toBe(200);
    expect(r.invoke).toHaveBeenCalledWith(operationId, tournamentId);
  });
  it('reports an unknown original outcome without retrying', async () => {
    const invoke = vi.fn(async () => {
      throw Error('lost');
    });
    const r = await request('isolated-service-key', { operationId, tournamentId }, invoke);
    expect(r.status).toBe(503);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
