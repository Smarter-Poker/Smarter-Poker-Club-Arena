import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  maintenanceSupabase: {},
}));
afterEach(() => vi.restoreAllMocks());

describe('a new cash occupancy between roster reads', () => {
  it.each(['waiting', 'moved'] as const)(
    'classifies the replacement stay with %s entry',
    async (hold) => {
      const engine = new ServerTableEngine('aaaaaaaa-1111-4111-8111-111111111111') as any;
      const prior = { user_id: 'player', occupancy_id: 'old-stay', seat_number: 1, stack: 100 };
      const replacement = {
        ...prior,
        occupancy_id: 'new-stay',
        seat_number: 4,
        entry_hold: hold,
        entry_post_agreed: true,
      };
      engine.running = true;
      engine.isCurrentEngine = () => true;
      engine.lifecycleCanMutate = () => true;
      engine.tableInfo = {
        id: engine.tableId,
        tournament_id: null,
        game_type: 'NLH',
        max_players: 6,
      };
      engine.seatedPlayers = [prior];
      engine.knownPlayerIds.add(prior.user_id);
      engine.dealtInUserIds.add(prior.user_id);
      engine.returningFromSitout.add(prior.user_id);
      engine.mustPostBB.add(prior.user_id);
      engine.horseRebuys.set(prior.user_id, 3);
      engine.dealingLoopFirstIteration = false;
      engine.prepareNextHand = vi.fn(async () => [replacement]);
      engine.adoptMovedPresence = vi.fn();
      engine.restoreSitOutsFromSeats = vi.fn();
      engine.evictExpiredSitOuts = vi.fn(async () => {});
      engine.persistEntryHold = vi.fn();
      engine.wakeClusterGame = vi.fn();
      engine.adminPauseLock = true;
      engine.sleep = vi.fn(async () => {
        engine.running = false;
      });
      const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
      await engine.dealingLoop();
      expect(engine.dealtInUserIds.has(prior.user_id)).toBe(false);
      expect(engine.returningFromSitout.has(prior.user_id)).toBe(false);
      expect(engine.mustPostBB.has(prior.user_id)).toBe(false);
      expect(engine.horseRebuys.has(prior.user_id)).toBe(false);
      expect(unregister).toHaveBeenCalledWith(engine.tableId, prior.user_id);
      expect(engine.waitingForBB.has(prior.user_id)).toBe(hold === 'waiting');
      expect(engine.postBBWhenClear.has(prior.user_id)).toBe(hold === 'waiting');
      expect(engine.wakeClusterGame).toHaveBeenCalledWith('seat_change');
    }
  );

  it('preserves entry and button state when the same stay is read again', async () => {
    const engine = new ServerTableEngine('aaaaaaaa-1111-4111-8111-111111111111') as any;
    const seat = { user_id: 'player', occupancy_id: 'same-stay', seat_number: 1, stack: 100 };
    engine.running = true;
    engine.lifecycleCanMutate = () => true;
    engine.tableInfo = {
      id: engine.tableId,
      tournament_id: null,
      game_type: 'NLH',
      max_players: 6,
    };
    engine.seatedPlayers = [seat];
    engine.knownPlayerIds.add(seat.user_id);
    engine.dealtInUserIds.add(seat.user_id);
    engine.mustPostBB.add(seat.user_id);
    engine.dealingLoopFirstIteration = false;
    engine.prepareNextHand = vi.fn(async () => [{ ...seat }]);
    engine.adoptMovedPresence = vi.fn();
    engine.restoreSitOutsFromSeats = vi.fn();
    engine.evictExpiredSitOuts = vi.fn(async () => {});
    engine.adminPauseLock = true;
    engine.sleep = vi.fn(async () => {
      engine.running = false;
    });
    const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
    await engine.dealingLoop();
    expect(engine.dealtInUserIds.has(seat.user_id)).toBe(true);
    expect(engine.mustPostBB.has(seat.user_id)).toBe(true);
    expect(unregister).not.toHaveBeenCalled();
  });

  it('does not adopt a late roster after this engine loses authority', async () => {
    const engine = new ServerTableEngine('aaaaaaaa-1111-4111-8111-111111111111') as any;
    const seat = { user_id: 'player', occupancy_id: 'old-stay', seat_number: 1, stack: 100 };
    engine.running = true;
    engine.seatedPlayers = [seat];
    let current = true;
    engine.lifecycleCanMutate = () => current;
    engine.prepareNextHand = vi.fn(async () => {
      current = false;
      return [{ ...seat, occupancy_id: 'new-stay' }];
    });
    engine.adoptMovedPresence = vi.fn();
    await engine.dealingLoop();
    expect(engine.seatedPlayers).toEqual([seat]);
    expect(engine.adoptMovedPresence).not.toHaveBeenCalled();
  });
});
