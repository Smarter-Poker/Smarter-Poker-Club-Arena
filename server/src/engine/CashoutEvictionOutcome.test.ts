import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cashout: vi.fn() }));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  markSeatAsLeft: vi.fn().mockResolvedValue(undefined),
  atomicCashout: (...args: unknown[]) => mocks.cashout(...args),
}));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
function engine() {
  const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
  e.tableInfo = { tournament_id: null, nit_game: false };
  e.seatedPlayers = [{ user_id: 'player', seat_number: 2, stack: 100 }];
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
beforeEach(() => vi.resetAllMocks());
describe('eviction only reflects a confirmed cashout', () => {
  it('does not emit a departure before the cashout resolves', async () => {
    const e = engine();
    let resolve!: (value: number) => void;
    mocks.cashout.mockReturnValue(
      new Promise<number>((r) => {
        resolve = r;
      })
    );
    const pending = e.evictExpiredSitOuts({ countOrbit: false });
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
    expect(e.seatedPlayers).toHaveLength(1);
    resolve(100);
    await pending;
    expect(e.hub.emitEvent).toHaveBeenCalledOnce();
    expect(e.disconnectEngine.unregisterPlayer).toHaveBeenCalledOnce();
    expect(e.seatedPlayers).toHaveLength(0);
  });
  it('retains the player on failure and succeeds on a later retry', async () => {
    const e = engine();
    mocks.cashout.mockRejectedValueOnce(new Error('unknown outcome')).mockResolvedValueOnce(0);
    await e.evictExpiredSitOuts({ countOrbit: false });
    expect(e.seatedPlayers).toHaveLength(1);
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
    expect(e.disconnectEngine.unregisterPlayer).not.toHaveBeenCalled();
    expect(mocks.cashout).toHaveBeenCalledTimes(1);
    await e.evictExpiredSitOuts({ countOrbit: false });
    expect(e.seatedPlayers).toHaveLength(0);
    expect(e.hub.emitEvent).toHaveBeenCalledOnce();
  });
  it('retains a player skipped because they are all-in', async () => {
    const e = engine();
    e.handController = {
      getState: () => ({ players: [{ user_id: 'player', is_all_in: true, is_folded: false }] }),
    };
    await e.evictExpiredSitOuts({ countOrbit: false });
    expect(e.seatedPlayers).toHaveLength(1);
    expect(mocks.cashout).not.toHaveBeenCalled();
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
  });
});
