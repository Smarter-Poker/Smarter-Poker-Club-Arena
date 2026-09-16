import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw new Error('Unexpected database read in pause fixture');
    }),
    rpc: vi.fn(() => {
      throw new Error('Unexpected database RPC in pause fixture');
    }),
  },
  maintenanceSupabase: {},
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function loopAtRest(arm: (engine: any) => void) {
  const engine = new ServerTableEngine('61616161-6161-4161-8161-616161616161') as any;
  const players = [1, 2, 3].map((n) => ({ user_id: 'player-' + n, seat_number: n, stack: 100 }));
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
  engine.adoptMovedPresence = vi.fn();
  engine.restoreSitOutsFromSeats = vi.fn();
  engine.evictExpiredSitOuts = vi.fn(async () => {});
  engine.announcePendingSeatMoves = vi.fn(async () => {});
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
  return { engine, parked };
}

describe('a pause arriving during prepared-hand rest', () => {
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
