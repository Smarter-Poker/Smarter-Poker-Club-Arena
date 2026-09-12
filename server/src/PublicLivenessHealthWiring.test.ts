import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from './GameServer.js';
import { createRouter } from './router.js';
import { mockRes, parseJson } from './handlers/_testHelpers.js';
import type { IncomingMessage } from 'node:http';

afterEach(() => vi.restoreAllMocks());

describe('public progress is bounded inside the real health snapshot', () => {
  it('keeps default probes compact and binds requested tables to the same status snapshot', async () => {
    const server = new GameServer();
    const tableId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const progress = {
      tableId,
      gameFormat: 'cash' as const,
      clubId: null,
      seated: 4,
      dealable: 4,
      humans: 0,
      handCount: 42,
      msSinceProgress: 100,
      settlementAgeMs: null,
      loopPhase: 'dealing+100ms',
      paused: false,
      isTournament: false,
    };
    const source = vi
      .spyOn(server as any, 'tableLivenessSnapshot')
      .mockReturnValue([progress, { ...progress, tableId: otherId }]);
    const ordinary = server.getStatus();
    expect(ordinary).not.toHaveProperty('tableLiveness');
    expect(ordinary.tableLivenessSummary.tables).toBe(2);
    source.mockClear();
    const { res, captured } = mockRes();
    await createRouter({ gameServer: server } as never)(
      {
        method: 'GET',
        url: `/health?liveness_table_ids=${tableId}`,
        headers: {},
      } as IncomingMessage,
      res
    );
    const body = parseJson(captured) as any;
    expect(source).toHaveBeenCalledTimes(1);
    expect(body.tableLiveness).toHaveLength(1);
    expect(body.tableLiveness[0]).toMatchObject({ tableId, handCount: 42, msSinceProgress: 100 });
    expect(body.tableLivenessSummary.tables).toBe(2);
    expect(body.version).toBe(ordinary.version);
    expect(body.releaseSha).toBe(ordinary.releaseSha);
    expect(body.liveness).toBe(ordinary.liveness);
    expect(JSON.stringify(body.tableLiveness)).not.toMatch(/isTournament|settlementAgeMs|humans/);
  });
});
