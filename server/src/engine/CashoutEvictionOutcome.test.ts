import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  cashout: vi.fn(),
  markLeft: vi.fn(),
  nitStatus: vi.fn(),
  nitEvictions: vi.fn(),
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  markSeatAsLeft: (...args: unknown[]) => mocks.markLeft(...args),
  atomicCashout: (...args: unknown[]) => mocks.cashout(...args),
}));
vi.mock('../services/supabase/nitGame.js', () => ({
  collectNitStatus: (...args: unknown[]) => mocks.nitStatus(...args),
  collectNitEvictions: (...args: unknown[]) => mocks.nitEvictions(...args),
}));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
function engine() {
  const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
  e.tableInfo = { tournament_id: null, nit_game: false };
  e.seatedPlayers = [
    {
      user_id: 'player',
      occupancy_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      seat_number: 2,
      stack: 100,
    },
  ];
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
  vi.resetAllMocks();
  mocks.markLeft.mockResolvedValue(undefined);
  mocks.nitStatus.mockResolvedValue([]);
  mocks.nitEvictions.mockResolvedValue([]);
});
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
  it.each([false, true])(
    'does not evict an unsettled hand participant: folded=%s',
    async (folded) => {
      const e = engine();
      e.handController = {
        getState: () => ({ players: [{ user_id: 'player', is_all_in: false, is_folded: folded }] }),
      };
      await e.evictExpiredSitOuts({ countOrbit: false });
      expect(mocks.cashout).not.toHaveBeenCalled();
      expect(e.seatedPlayers).toHaveLength(1);
      expect(e.hub.emitEvent).not.toHaveBeenCalled();
    }
  );
  it('holds the next hand boundary until an eviction cashout is confirmed', async () => {
    const e = engine();
    let finish!: () => void;
    mocks.cashout.mockReturnValue(
      new Promise<number>((resolve) => {
        finish = () => resolve(100);
      })
    );
    const evicting = e.evictExpiredSitOuts({ countOrbit: false });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.cashout).toHaveBeenCalledOnce();
    let releaseNext: (() => void) | undefined;
    const queued = e.acquireSeatBoundary().then((release: () => void) => {
      releaseNext = release;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(releaseNext).toBeUndefined();
    finish();
    await evicting;
    await queued;
    expect(e.seatedPlayers).toHaveLength(0);
    releaseNext!();
  });
  it('does not transfer a candidate eviction onto a rejoin during an eligibility read', async () => {
    const e = engine();
    e.tableInfo.nit_game = true;
    let finish!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((done) => {
      signalStarted = done;
    });
    mocks.nitStatus.mockImplementation(() => {
      signalStarted();
      return new Promise<[]>((resolve) => {
        finish = () => resolve([]);
      });
    });
    const evicting = e.evictExpiredSitOuts({ countOrbit: false });
    await started;
    const replacement = {
      ...e.seatedPlayers[0],
      occupancy_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      stack: 40,
    };
    e.seatedPlayers = [replacement];
    finish();
    await evicting;
    expect(mocks.cashout).not.toHaveBeenCalled();
    expect(e.seatedPlayers).toEqual([replacement]);
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
  });
  it('does not cash out a player who returned during an eligibility read', async () => {
    const e = engine();
    e.tableInfo.nit_game = true;
    let sittingOut = true;
    e.disconnectEngine.tickSitOutsAndCollectEvictions = () => (sittingOut ? ['player'] : []);
    let finish!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((done) => {
      signalStarted = done;
    });
    mocks.nitStatus.mockImplementation(() => {
      signalStarted();
      return new Promise<[]>((resolve) => {
        finish = () => resolve([]);
      });
    });
    const evicting = e.evictExpiredSitOuts({ countOrbit: false });
    await started;
    sittingOut = false;
    finish();
    await evicting;
    expect(mocks.cashout).not.toHaveBeenCalled();
    expect(e.seatedPlayers).toHaveLength(1);
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
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

function bustedEngine() {
  const e = engine();
  e.seatedPlayers[0].stack = 0;
  e.bustedSince = new Map([['player', Date.now() - 3600000]]);
  e.rebuyPromptOpenAt = new Map();
  e.pendingAddOns = new Map();
  e.usersWithPendingLedgerChips = vi.fn().mockResolvedValue(new Set());
  return e;
}
describe('busted seat departure confirmation', () => {
  it('waits for the cashout receipt before broadcasting or clearing the seat', async () => {
    const e = bustedEngine();
    let resolve!: (value: number) => void;
    mocks.cashout.mockReturnValue(
      new Promise<number>((r) => {
        resolve = r;
      })
    );
    const pending = e.standUpBustedCashPlayers();
    await Promise.resolve();
    expect(mocks.cashout).toHaveBeenCalledOnce();
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
    expect(e.seatedPlayers).toHaveLength(1);
    resolve(0);
    await pending;
    expect(e.hub.emitEvent).toHaveBeenCalledOnce();
    expect(e.seatedPlayers).toHaveLength(0);
  });
  it('preserves tracking on failure and confirms the next retry before removal', async () => {
    const e = bustedEngine();
    mocks.cashout.mockRejectedValueOnce(new Error('unknown outcome')).mockResolvedValueOnce(0);
    await e.standUpBustedCashPlayers();
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
    expect(e.seatedPlayers).toHaveLength(1);
    expect(e.bustedSince.has('player')).toBe(true);
    expect(e.chipContinuity.forget).not.toHaveBeenCalled();
    expect(e.disconnectEngine.unregisterPlayer).not.toHaveBeenCalled();
    await e.standUpBustedCashPlayers();
    expect(mocks.cashout).toHaveBeenCalledTimes(2);
    expect(e.seatedPlayers).toHaveLength(0);
    expect(e.bustedSince.has('player')).toBe(false);
    expect(e.hub.emitEvent).toHaveBeenCalledOnce();
  });
});
