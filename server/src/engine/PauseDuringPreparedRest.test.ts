import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const checkpoint = vi.hoisted(() => ({ row: null as any, error: null as Error | null }));

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'engine_presence_parked')
        return {
          upsert: async (row: unknown) => {
            if (!checkpoint.error) checkpoint.row = row;
            return { error: checkpoint.error };
          },
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: checkpoint.row, error: null }) }),
          }),
        };
      throw new Error('Unexpected database read in pause fixture');
    }),
    rpc: vi.fn(() => {
      throw new Error('Unexpected database RPC in pause fixture');
    }),
  },
  maintenanceSupabase: {},
}));

beforeEach(() => {
  checkpoint.row = null;
  checkpoint.error = null;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function loopAtRest(arm: (engine: any) => void) {
  const engine = new ServerTableEngine('61616161-6161-4161-8161-616161616161') as any;
  const players = [1, 2, 3].map((n) => ({
    user_id: `11111111-1111-4111-8111-11111111111${n}`,
    occupancy_id: `22222222-2222-4222-8222-22222222222${n}`,
    seat_number: n,
    stack: 100,
  }));
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = {
    id: engine.tableId,
    tournament_id: 'event',
    game_type: 'NLH',
    max_players: 6,
  };
  engine.seatedPlayers = players;
  engine.knownPlayerIds = new Set(players.map((p) => p.user_id));
  engine.dealingLoopFirstIteration = false;
  engine.prepareNextHand = vi.fn(async () => players);
  engine.adoptMovedPresence = vi.fn().mockResolvedValue(true);
  engine.restoreSitOutsFromSeats = vi.fn();
  engine.evictExpiredSitOuts = vi.fn(async () => {});
  engine.announcePendingSeatMoves = vi.fn(async () => true);
  const nativePersist = engine.persistPresenceForRestart;
  engine.persistPresenceForRestart = vi.fn(async () => {});
  engine.hasOpenBountyReveal = () => false;
  engine.awaitNextHandRest = vi.fn(async () => arm(engine));
  engine.dealHand = vi.fn(async () => {
    engine.running = false;
  });
  engine.sleep = vi.fn(async () => {
    engine.running = false;
  });
  const parked = vi.fn(() => {
    engine.running = false;
    engine.handForHandResolve?.();
  });
  engine.onPauseReady(parked);
  return { engine, parked, nativePersist };
}

describe('a pause arriving during prepared-hand rest', () => {
  it.each([false, true])(
    'runs the native bank checkpoint at the actual post-rest edge (refused=%s)',
    async (refused) => {
      const { engine, parked, nativePersist } = loopAtRest((e) => e.pauseForMaintenance(300000));
      engine.persistPresenceForRestart = nativePersist;
      engine.parkWriteRetryMs = 0;
      engine.handCount = 12;
      const player = engine.seatedPlayers[0];
      engine.timeBankEngine.initializePlayer(engine.tableId, player.user_id, {
        remainingSeconds: 7,
        usesRemaining: 1,
      });
      engine.timeBankMeta.set(player.user_id, {
        initialSeconds: 80,
        baseSeconds: 40,
        dbConsumedSeconds: 33,
      });
      if (refused) checkpoint.error = new Error('checkpoint refused');
      await engine.dealingLoop();
      expect(engine.dealHand).not.toHaveBeenCalled();
      expect(parked).toHaveBeenCalledOnce();
      expect(engine.isMaintenanceStateDurable()).toBe(!refused);
      if (refused) {
        expect(checkpoint.row).toBeNull();
        expect(
          engine.timeBankEngine.getPlayerBank(engine.tableId, player.user_id).remainingSeconds
        ).toBe(7);
      } else {
        expect(checkpoint.row.engine_instance).toMatch(/:parked$/);
        expect(checkpoint.row.time_bank_snapshot.players[player.user_id]).toEqual({
          occupancyId: player.occupancy_id,
          remainingSeconds: 7,
          usesRemaining: 1,
          initialSeconds: 80,
          baseSeconds: 40,
          dbConsumedSeconds: 33,
          unlimitedActivations: false,
        });
        const next = new ServerTableEngine(engine.tableId) as any;
        next.lifecycleCanMutate = () => true;
        next.handCount = 12;
        await next.readParkedTimeBanks();
        next.adoptSeatRoster([player]);
        expect(next.timeBankEngine.getPlayerBank(engine.tableId, player.user_id)).toMatchObject({
          remainingSeconds: 7,
          usesRemaining: 1,
          unlimitedActivations: false,
        });
        expect(next.timeBankMeta.get(player.user_id).dbConsumedSeconds).toBe(33);
        expect(next.timeBankMeta.get(player.user_id).unlimitedActivations ?? false).toBe(false);
      }
    }
  );
  it.each([
    ['maintenance', (e: any) => e.pauseForMaintenance(300_000)],
    ['deal discussion', (e: any) => e.pauseForFinalTableDeal(60_000)],
    ['synchronized break', (e: any) => e.pauseAfterHand(420_000, { beforeNextHand: true })],
  ] as const)('parks before the next deal for %s', async (_name, arm) => {
    const { engine, parked } = loopAtRest(arm);
    await engine.dealingLoop();
    expect(engine.awaitNextHandRest).toHaveBeenCalledOnce();
    expect(engine.dealHand).not.toHaveBeenCalled();
    expect(parked).toHaveBeenCalledOnce();
    if (_name === 'maintenance') {
      expect(engine.persistPresenceForRestart).toHaveBeenCalledWith('parked');
      const checkpoint = engine.persistPresenceForRestart.mock.calls.findIndex(
        ([when]: [string]) => when === 'parked'
      );
      expect(engine.persistPresenceForRestart.mock.invocationCallOrder[checkpoint]).toBeLessThan(
        parked.mock.invocationCallOrder[0]
      );
    }
  });

  it('honors an operator pause before dealing', async () => {
    const { engine } = loopAtRest((e) => e.adminPause());
    await engine.dealingLoop();
    expect(engine.awaitNextHandRest).toHaveBeenCalledOnce();
    expect(engine.dealHand).not.toHaveBeenCalled();
    expect(engine.adminPauseLock).toBe(true);
    expect(engine.sleep).toHaveBeenCalledWith(3000);
  });

  it('allows the next shared hand after the ordinary hand-for-hand re-arm', async () => {
    const { engine, parked } = loopAtRest((e) => e.pauseAfterHand());
    await engine.dealingLoop();
    expect(engine.dealHand).toHaveBeenCalledOnce();
    expect(parked).not.toHaveBeenCalled();
  });
});
