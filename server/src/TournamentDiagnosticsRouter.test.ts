import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const KEY = 'fixture-only-tournament-diagnostic-key';
const TID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TABLE = 'bbbbbbbb-0000-4000-8000-000000000002';
let createRouter: (typeof import('./router.js'))['createRouter'];
beforeAll(async () => {
  vi.stubEnv('INTERNAL_API_KEY', KEY);
  vi.resetModules();
  ({ createRouter } = await import('./router.js'));
});
afterAll(async () => {
  const { tournamentEliminationScheduler } =
    await import('./tournament/TournamentEliminationScheduler.js');
  tournamentEliminationScheduler.stop();
  vi.unstubAllEnvs();
});
function evidence(extra: Record<string, unknown> = {}) {
  return {
    schema: 'tournament-lifecycle-diagnostic/v1',
    diagnosticOnly: true,
    tournamentId: TID,
    owners: [],
    missingMeans: 'unknown',
    ...extra,
  };
}
async function request(
  target: string,
  gameServer: any,
  auth: unknown = 'Bearer ' + KEY,
  method = 'GET'
) {
  const captured = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    setHeader: (key: string, value: unknown) => {
      captured.headers[key.toLowerCase()] = value;
    },
    writeHead: (status: number, headers: Record<string, unknown> = {}) => {
      captured.status = status;
      for (const [key, value] of Object.entries(headers))
        captured.headers[key.toLowerCase()] = value;
    },
    end: (text = '') => {
      captured.body += text;
    },
  } as unknown as ServerResponse;
  await createRouter({ gameServer } as any)(
    { method, url: target, headers: { authorization: auth } } as IncomingMessage,
    res
  );
  return captured;
}
const path = '/internal/tournament-diagnostics/' + TID;

describe('dedicated authenticated tournament observation route', () => {
  it.each([undefined, '', 'wrong', 'Bearer wrong', ['Bearer ' + KEY]].map((auth) => ({ auth })))(
    'rejects malformed or absent authentication before observation (%j)',
    async ({ auth }) => {
      const capture = vi.fn(() => evidence());
      // null is used for omitted default argument semantics in the request fixture.
      const result = await request(
        path,
        { getTournamentLifecycleDiagnostic: capture },
        auth === undefined ? null : auth
      );
      expect(result.status).toBe(401);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(capture).not.toHaveBeenCalled();
    }
  );

  it('uses one exact scope and canonical UUID identity without another read', async () => {
    const capture = vi.fn(() => evidence({ expectedIdentityMatch: 'mismatch' }));
    const result = await request(
      path
        .toUpperCase()
        .replace('/INTERNAL/TOURNAMENT-DIAGNOSTICS/', '/internal/tournament-diagnostics/') +
        '?table_ids=' +
        TABLE.toUpperCase() +
        '&lease_generation=' +
        TABLE,
      { getTournamentLifecycleDiagnostic: capture }
    );
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(
      TID,
      { tableIds: [TABLE] },
      { managerInstanceId: undefined, leaseGeneration: TABLE }
    );
    expect(JSON.parse(result.body)).toMatchObject({
      expectedIdentityMatch: 'mismatch',
      missingMeans: 'unknown',
    });
  });

  it.each([
    '/internal/tournament-diagnostics/not-a-uuid',
    path + '?unknown=true',
    path + '?table_ids=',
    path + '?table_ids=' + TABLE + ',' + TABLE,
    path + '?lease_generation=' + TABLE + '&lease_generation=' + TABLE,
    path +
      '?table_ids=' +
      Array.from(
        { length: 9 },
        (_, n) => 'bbbbbbbb-0000-4000-8000-' + String(n).padStart(12, '0')
      ).join(','),
    path + '?manager_instance_id=%20' + TABLE,
    path + '?manager_instance_id={' + TABLE + '}',
    path + '?table_ids=' + TABLE + '?manager_instance_id=' + TABLE,
    path + '?table_ids=' + 'x'.repeat(2048),
    path + '/extra',
  ])('rejects invalid scope %s without a getter call', async (target) => {
    const capture = vi.fn(() => evidence());
    const result = await request(target, { getTournamentLifecycleDiagnostic: capture });
    expect(result.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects writes and unavailable observers without changing another route', async () => {
    const capture = vi.fn(() => evidence());
    expect(
      (await request(path, { getTournamentLifecycleDiagnostic: capture }, 'Bearer ' + KEY, 'POST'))
        .status
    ).toBe(405);
    expect(capture).not.toHaveBeenCalled();
    expect((await request(path, {})).status).toBe(503);
    const getStatus = vi.fn(() => ({
      liveness: 'ok',
      status: 'ok',
      dealerPrerequisitesReady: true,
      liveHorseDecision: { phase: 'ready' },
    }));
    const health = await request('/health?liveness_table_ids=' + TABLE, {
      getStatus,
      getTournamentLifecycleDiagnostic: capture,
    });
    expect(health.status).toBe(200);
    expect(getStatus).toHaveBeenCalledWith({ kind: 'tables', tableIds: [TABLE] });
    expect(capture).not.toHaveBeenCalled();
  });

  it('never invokes arbitrary accessors or toJSON during serialization', async () => {
    const getter = vi.fn(() => []);
    const snapshot = evidence();
    Object.defineProperty(snapshot, 'owners', { get: getter, enumerable: true });
    const rejected = await request(path, { getTournamentLifecycleDiagnostic: () => snapshot });
    expect(rejected.status).toBe(503);
    expect(getter).not.toHaveBeenCalled();
    const toJSON = vi.fn(() => {
      throw new Error('must not execute');
    });
    const accepted = await request(path, {
      getTournamentLifecycleDiagnostic: () => evidence({ toJSON }),
    });
    expect(accepted.status).toBe(200);
    expect(toJSON).not.toHaveBeenCalled();
    expect(accepted.body).not.toContain('toJSON');
  });

  it('fails boundedly for wrong identity, cycles, excessive records and oversized bytes without retrying capture', async () => {
    const cycle = evidence();
    cycle.owners = [cycle] as never;
    const record = { event: 'writer_pending', reason: 'x'.repeat(256) };
    const tooManyBytes = evidence({
      owners: Array.from({ length: 4 }, () => ({
        snapshot: {
          originals: Array.from({ length: 8 }, () => ({
            engine: { records: Array.from({ length: 32 }, () => record) },
          })),
        },
      })),
    });
    for (const snapshot of [
      evidence({ tournamentId: TABLE }),
      cycle,
      evidence({ owners: Array(65).fill(null) }),
      tooManyBytes,
    ]) {
      const capture = vi.fn(() => snapshot);
      const result = await request(path, { getTournamentLifecycleDiagnostic: capture });
      expect(result.status).toBe(503);
      expect(Buffer.byteLength(result.body)).toBeLessThan(1024);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(capture).toHaveBeenCalledOnce();
    }
  });

  it('preserves valid null/unavailable fields and optional lifecycle fields', async () => {
    const result = await request(path, {
      getTournamentLifecycleDiagnostic: () =>
        evidence({
          owners: [
            {
              roles: ['current'],
              snapshot: {
                leaseRelease: { status: 'confirmed', attempts: 1, releasedCount: 0 },
                originals: [
                  {
                    tableId: TABLE,
                    availability: 'unavailable',
                    engine: null,
                    session: null,
                    sessionCoverage: 'unavailable_on_selected_base',
                  },
                ],
                records: [{ event: 'stop_initiated', operationId: undefined }],
              },
            },
          ],
        }),
    });
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.owners[0].snapshot.originals[0]).toMatchObject({
      engine: null,
      session: null,
      availability: 'unavailable',
    });
    expect(parsed.owners[0].snapshot.leaseRelease.releasedCount).toBe(0);
    expect(parsed.owners[0].snapshot.records[0]).not.toHaveProperty('operationId');
  });

  it('fails closed when the module is loaded without an internal key', async () => {
    const priorScheduler = await import('./tournament/TournamentEliminationScheduler.js');
    priorScheduler.tournamentEliminationScheduler.stop();
    vi.resetModules();
    vi.stubEnv('INTERNAL_API_KEY', '');
    ({ createRouter } = await import('./router.js'));
    const capture = vi.fn(() => evidence());
    expect((await request(path, { getTournamentLifecycleDiagnostic: capture })).status).toBe(401);
    expect(capture).not.toHaveBeenCalled();
  });
});
