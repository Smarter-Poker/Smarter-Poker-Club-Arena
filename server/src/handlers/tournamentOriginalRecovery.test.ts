import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  handleTournamentOriginalRecoveryPrepare,
  ORIGINAL_RECOVERY_OPERATION,
  ORIGINAL_RECOVERY_TWENTY,
} from './tournamentOriginalRecovery.js';
afterEach(() => vi.unstubAllEnvs());
async function request(
  token: string,
  body: unknown,
  invoke = vi.fn(() => ({ state: 'prepared' }))
) {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'isolated-service-key');
  const req = Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const result = { status: 0, body: '' };
  const res = {
    setHeader: vi.fn(),
    writeHead: (s: number) => {
      result.status = s;
    },
    end: (s: string) => {
      result.body = s;
    },
  };
  await handleTournamentOriginalRecoveryPrepare(req as any, res as any, {
    gameServer: { prepareTournamentOriginalRecovery: invoke },
  });
  return { ...result, invoke };
}
const body = {
  operationId: ORIGINAL_RECOVERY_OPERATION,
  tournamentId: [...ORIGINAL_RECOVERY_TWENTY][0],
  nonce: '13000000-0000-4000-8000-000000000001',
};
it('uses existing configured service authority rather than unsigned role claims', async () => {
  const r = await request('header.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake', body);
  expect(r.status).toBe(401);
  expect(r.invoke).not.toHaveBeenCalled();
});
it.each([
  { ...body, tournamentId: '23000000-0000-4000-8000-000000000001' },
  { ...body, proof: true },
  { ...body, nonce: '' },
])('refuses other69 or caller supplied proof/invalid nonce', async (input) => {
  const r = await request('isolated-service-key', input);
  expect(r.status).toBe(400);
  expect(r.invoke).not.toHaveBeenCalled();
});
it('prepares only the exact operation event and nonce once', async () => {
  const r = await request('isolated-service-key', body);
  expect(r.status).toBe(200);
  expect(r.invoke).toHaveBeenCalledTimes(1);
  expect(r.invoke).toHaveBeenCalledWith(body.operationId, body.tournamentId, body.nonce);
});
it('retains unknown acknowledgement without automatic retry', async () => {
  const invoke = vi.fn(() => {
    throw Error('unknown');
  });
  const r = await request('isolated-service-key', body, invoke);
  expect(r.status).toBe(503);
  expect(r.invoke).toHaveBeenCalledTimes(1);
});

it('explicit readback never calls prepare', async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'isolated-service-key');
  const req = Object.assign(Readable.from([JSON.stringify({ ...body, action: 'read' })]), {
    method: 'POST',
    headers: { authorization: 'Bearer isolated-service-key' },
  });
  const result = { status: 0 };
  const res = {
    setHeader: vi.fn(),
    writeHead: (s: number) => {
      result.status = s;
    },
    end: vi.fn(),
  };
  const prepare = vi.fn();
  const read = vi.fn(() => ({ state: 'prepared' }));
  await handleTournamentOriginalRecoveryPrepare(req as any, res as any, {
    gameServer: {
      prepareTournamentOriginalRecovery: prepare,
      readTournamentOriginalRecoveryPreparation: read,
    },
  });
  expect(result.status).toBe(200);
  expect(prepare).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});
