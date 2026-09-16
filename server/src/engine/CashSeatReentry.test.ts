import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as database from '../services/supabase.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  maintenanceSupabase: {},
}));
afterEach(() => vi.restoreAllMocks());

describe('a new cash occupancy between roster reads', () => {
  it.each(['arrival', 'replacement', 'departure'] as const)(
    'preserves the %s notification while arrival proof is unavailable',
    async (mode) => {
      const engine = new ServerTableEngine('aaaaaaaa-1111-4111-8111-111111111111') as any;
      const prior = { user_id: 'player', occupancy_id: 'old-stay', seat_number: 1, stack: 100 };
      const arrival = { ...prior, occupancy_id: 'new-stay', seat_number: 4, entry_hold: 'moved' };
      const retained = {
        user_id: 'retained',
        occupancy_id: 'same-stay',
        seat_number: 2,
        stack: 100,
      };
      engine.running = true;
      engine.isCurrentEngine = () => true;
      engine.lifecycleCanMutate = () => engine.running;
      engine.tableInfo = {
        id: engine.tableId,
        tournament_id: null,
        game_type: 'NLH',
        max_players: 6,
      };
      engine.seatedPlayers = mode === 'arrival' ? [retained] : [prior, retained];
      for (const seat of engine.seatedPlayers) engine.knownPlayerIds.add(seat.user_id);
      engine.dealingLoopFirstIteration = false;
      engine.prepareNextHand = vi.fn(async () =>
        mode === 'departure' ? [retained] : [arrival, retained]
      );
      engine.adoptMovedPresence = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      engine.restoreSitOutsFromSeats = vi.fn();
      engine.evictExpiredSitOuts = vi.fn(async () => {});
      engine.persistEntryHold = vi.fn();
      engine.wakeClusterGame = vi.fn();
      engine.hub = { emitEvent: vi.fn() };
      engine.adminPauseLock = true;
      let waits = 0;
      engine.sleep = vi.fn(async () => {
        waits++;
        if (waits === 1) {
          expect(engine.restoreSitOutsFromSeats).not.toHaveBeenCalled();
          expect(engine.hub.emitEvent).not.toHaveBeenCalled();
          expect(engine.wakeClusterGame).not.toHaveBeenCalled();
        }
        // One failed proof, one successful observation and one unchanged
        // observation: the real loop must deliver the diff exactly once.
        if (waits === 3) engine.running = false;
      });
      await engine.dealingLoop();
      expect(engine.adoptMovedPresence).toHaveBeenCalledTimes(3);
      expect(engine.restoreSitOutsFromSeats).toHaveBeenCalledTimes(2);
      const arrivals = engine.hub.emitEvent.mock.calls.filter(
        ([, event]: [string, { type: string }]) => event.type === 'seat_taken'
      );
      expect(arrivals).toEqual(
        mode === 'departure'
          ? []
          : [
              [
                engine.tableId,
                expect.objectContaining({
                  type: 'seat_taken',
                  user_id: prior.user_id,
                  seat: 4,
                }),
              ],
            ]
      );
      expect(engine.wakeClusterGame).toHaveBeenCalledTimes(1);
      expect(engine.wakeClusterGame).toHaveBeenCalledWith('seat_change');
    }
  );

  it.each(['same', 'replaced', 'empty-between'] as const)(
    'the startup waiting loop retires prior occupancies (%s)',
    async (mode) => {
      const replaced = mode !== 'same';
      const engine = new ServerTableEngine('aaaaaaaa-1111-4111-8111-111111111111') as any;
      const prior = { user_id: 'player', occupancy_id: 'old-stay', seat_number: 1, stack: 100 };
      engine.seatedPlayers = [prior];
      engine.knownPlayerIds.add(prior.user_id);
      engine.dealtInUserIds.add(prior.user_id);
      engine.mustPostBB.add(prior.user_id);
      engine.horseRebuys.set(prior.user_id, 3);
      engine.disconnectEngine.registerPlayer(engine.tableId, prior.user_id);
      engine.timeBankEngine.initializePlayer(engine.tableId, prior.user_id, {
        remainingSeconds: 11,
        usesRemaining: 1,
        unlimitedActivations: false,
      });
      engine.timeBankMeta.set(prior.user_id, {
        initialSeconds: 40,
        baseSeconds: 30,
        dbConsumedSeconds: 4,
      });
      engine.engineLeaseAuthorityIsCurrent = () => true;
      engine.claimProcessOwnership = () => true;
      engine.armEngineLeaseExpiryTimer = vi.fn();
      engine.lifecycleCanMutate = () => engine.running;
      engine.applyRunItTwiceConfig = () => ({ insuranceEnabled: false });
      engine.seedHandCountFromHistory = vi.fn(async () => {});
      engine.restoreButtonFromHistory = vi.fn(async () => {});
      engine.checkCrashRecovery = vi.fn(async () => false);
      engine.processPendingAddOns = vi.fn(async () => {});
      engine.restoreEntryHoldsFromSeats = vi.fn();
      engine.evictExpiredSitOuts = vi.fn(async () => {});
      engine.executeIdleSeatMoves = vi.fn(async () => []);
      engine.stopIfClusterTableClosed = vi.fn(async () => {});
      engine.broadcastCurrentState = vi.fn(async () => {});
      engine.wakeClusterGame = vi.fn();
      engine.sleep = vi.fn(async () => {});
      vi.spyOn(database, 'loadTable').mockResolvedValue({
        id: engine.tableId,
        tournament_id: null,
        game_type: 'NLH',
        max_players: 6,
      } as any);
      vi.spyOn(database, 'loadPresenceFromPark').mockResolvedValue(null);
      const rosterRead = vi.spyOn(database, 'loadSeatedPlayers');
      if (mode === 'empty-between')
        rosterRead.mockResolvedValueOnce([prior] as any).mockResolvedValueOnce([]);
      rosterRead.mockResolvedValue([
        { ...prior, occupancy_id: replaced ? 'new-stay' : prior.occupancy_id },
      ] as any);
      const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
      let sweeps = 0;
      engine.restoreSitOutsFromSeats = vi.fn(() => {
        sweeps++;
        const retired = replaced && (mode !== 'empty-between' || sweeps > 1);
        expect(engine.dealtInUserIds.has(prior.user_id)).toBe(!retired);
        expect(engine.mustPostBB.has(prior.user_id)).toBe(!retired);
        expect(engine.horseRebuys.has(prior.user_id)).toBe(!retired);
        expect(engine.timeBankMeta.has(prior.user_id)).toBe(!retired);
        if (mode !== 'empty-between' || sweeps === 3) engine.running = false;
      });
      await engine.start();
      expect(engine.restoreSitOutsFromSeats).toHaveBeenCalledTimes(
        mode === 'empty-between' ? 3 : 1
      );
      expect(unregister).toHaveBeenCalledTimes(replaced ? 1 : 0);
      if (mode === 'empty-between') {
        expect(engine.wakeClusterGame).toHaveBeenCalledTimes(2);
        expect(engine.wakeClusterGame).toHaveBeenCalledWith('seat_change');
      }
    }
  );

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
      engine.adoptMovedPresence = vi.fn().mockResolvedValue(true);
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
    engine.adoptMovedPresence = vi.fn().mockResolvedValue(true);
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
    engine.adoptMovedPresence = vi.fn().mockResolvedValue(true);
    await engine.dealingLoop();
    expect(engine.seatedPlayers).toEqual([seat]);
    expect(engine.adoptMovedPresence).not.toHaveBeenCalled();
  });
});
