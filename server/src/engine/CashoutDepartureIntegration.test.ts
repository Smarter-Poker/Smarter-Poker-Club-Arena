import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(() => {
    throw new Error('Unexpected database query in isolated departure test');
  }),
}));
const financial = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('../services/financialPush.js', () => ({ pushFinancialUpdate: financial.push }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: transport,
  maintenanceSupabase: transport,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
// Uses the real engine and cashout service through its public barrel. Only the
// database transport is isolated. This is not a live database/browser test.
const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = {
  ok: true,
  stack: 0,
  credited: false,
  seat_number: 2,
  occupancy_id: occupancyId,
  user_id: 'player',
  table_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  idempotency_key: 'cashout:occupancy:' + occupancyId,
  tournament_table: false,
};
function engine() {
  const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
  e.tableInfo = { tournament_id: null, nit_game: false };
  e.seatedPlayers = [{ user_id: 'player', seat_number: 2, stack: 100, occupancy_id: occupancyId }];
  e.disconnectEngine = {
    tickSitOutsAndCollectEvictions: () => ['player'],
    collectAwayBlindEvictions: () => [],
    collectAbandonedSeatEvictions: () => [],
    unregisterPlayer: vi.fn(),
  };
  for (const name of ['timeBankEngine', 'straddleEngine', 'preActionEngine'])
    e[name] = { removePlayer: vi.fn() };
  e.chipContinuity = { forget: vi.fn() };
  e.hub = { emitEvent: vi.fn() };
  e.handController = null;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
});
for (const path of ['eviction', 'busted'] as const) {
  describe(`engine/service integration: ${path}`, () => {
    function scenario() {
      const e = engine();
      if (path === 'busted') {
        e.seatedPlayers[0].stack = 0;
        e.bustedSince = new Map([['player', Date.now() - 3600000]]);
        e.rebuyPromptOpenAt = new Map();
        e.pendingAddOns = new Map();
        e.usersWithPendingLedgerChips = vi.fn().mockResolvedValue(new Set());
      }
      return {
        e,
        sweep: () =>
          path === 'busted'
            ? e.standUpBustedCashPlayers()
            : e.evictExpiredSitOuts({ countOrbit: false }),
      };
    }
    it.each([
      { data: null, error: { message: 'response lost after commit' } },
      { data: { ok: true, stack: 0 }, error: null },
      { data: { ok: false, stack: 0 }, error: null },
    ])(
      'retains tracking on ambiguous outcome and accepts the original receipt on retry %#',
      async (first) => {
        const { e, sweep } = scenario();
        transport.rpc.mockResolvedValueOnce(first).mockResolvedValueOnce({
          data: receipt,
          error: null,
        });
        await sweep();
        expect(financial.push).not.toHaveBeenCalled();
        expect(e.seatedPlayers).toHaveLength(1);
        expect(e.hub.emitEvent).not.toHaveBeenCalled();
        expect(e.disconnectEngine.unregisterPlayer).not.toHaveBeenCalled();
        expect(e.chipContinuity.forget).not.toHaveBeenCalled();
        expect(transport.rpc).toHaveBeenCalledTimes(1);
        await sweep();
        expect(e.seatedPlayers).toHaveLength(0);
        expect(e.hub.emitEvent).toHaveBeenCalledOnce();
        expect(e.disconnectEngine.unregisterPlayer).toHaveBeenCalledOnce();
        expect(
          transport.rpc.mock.calls.filter(([name]) => name === 'fn_cashout_seat_occupancy')
        ).toHaveLength(2);
        for (const [name, args] of transport.rpc.mock.calls.filter(
          ([name]) => name === 'fn_cashout_seat_occupancy'
        )) {
          expect(name).toBe('fn_cashout_seat_occupancy');
          expect(args).toMatchObject({
            p_user_id: 'player',
            p_occupancy_id: occupancyId,
            p_seat_number: 2,
            p_table_id: e.tableId,
          });
        }
        expect(transport.from).not.toHaveBeenCalled();
        expect(financial.push).toHaveBeenCalledOnce();
      }
    );
    it.each([false, true])(
      'waits for proof and preserves a replacement occupancy: rejoined=%s',
      async (rejoined) => {
        const { e, sweep } = scenario();
        let resolve!: (value: unknown) => void;
        transport.rpc.mockImplementation((name: string) => {
          if (name === 'fn_cashout_seat_occupancy')
            return new Promise((r) => {
              resolve = r;
            });
          if (name === 'fn_offer_open_seat')
            return Promise.resolve({ data: { ok: false, reason: 'nobody_waiting' }, error: null });
          throw new Error(`Unexpected RPC: ${name}`);
        });
        const pending = sweep();
        await Promise.resolve();
        expect(transport.rpc).toHaveBeenCalledTimes(1);
        expect(e.hub.emitEvent).not.toHaveBeenCalled();
        if (rejoined)
          e.seatedPlayers = [
            {
              ...e.seatedPlayers[0],
              occupancy_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              stack: 40,
            },
          ];
        resolve({
          data: receipt,
          error: null,
        });
        await pending;
        expect(e.seatedPlayers).toHaveLength(rejoined ? 1 : 0);
        expect(e.hub.emitEvent).toHaveBeenCalledTimes(rejoined ? 0 : 1);
        expect(e.disconnectEngine.unregisterPlayer).toHaveBeenCalledTimes(rejoined ? 0 : 1);
        expect(transport.rpc.mock.calls.map(([name]) => name)).toEqual([
          'fn_cashout_seat_occupancy',
          'fn_offer_open_seat',
        ]);
      }
    );
  });
}
