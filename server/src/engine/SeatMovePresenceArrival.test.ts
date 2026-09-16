import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const readers = vi.hoisted(() => ({ arrivals: vi.fn() }));
vi.mock('../services/supabase/cashMovePresence.js', () => ({
  readCashMoveArrivals: readers.arrivals,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import * as moves from '../services/supabase/seatMoves.js';
import { depositMovedPresence, hasMovedPresence, resetMovedPresence } from './SeatMovePresence.js';

const table = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';
const sourceStay = '33333333-3333-4333-8333-333333333333';
const destinationStay = '44444444-4444-4444-8444-444444444444';
const player = '55555555-5555-4555-8555-555555555555';
const move = '66666666-6666-4666-8666-666666666666';
const arrival = {
  move_id: move,
  player_id: player,
  from_table_id: source,
  to_table_id: table,
  source_occupancy_id: sourceStay,
  destination_occupancy_id: destinationStay,
};
const fsm = { state: 'SAT_OUT' as const, sinceMs: 1, graceDeadlineMs: null };
const bank = {
  remainingSeconds: 11,
  usesRemaining: 1,
  unlimitedActivations: false,
  initialSeconds: 40,
  baseSeconds: 30,
  dbConsumedSeconds: 4,
};
function deposit() {
  depositMovedPresence(player, table, {
    moveId: move,
    sourceOccupancyId: sourceStay,
    fromTableId: source,
    fsm,
    timeBank: bank,
  });
}
function engineAtDestination() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = table;
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.seatedPlayers = [{ user_id: player, occupancy_id: destinationStay }];
  engine.disconnectEngine = { restoreFsmStates: vi.fn(() => 1) };
  engine.timeBankEngine = { getPlayerBank: vi.fn(), initializePlayer: vi.fn() };
  engine.timeBankMeta = new Map();
  return engine;
}
beforeEach(() => {
  vi.resetAllMocks();
  resetMovedPresence();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetMovedPresence();
});

describe('the destination adopts only the transfer that created this stay', () => {
  it.each([false, true])(
    'stages current boundary presence before a delayed executor reply (announcedOnly=%s)',
    async (announcedOnly) => {
      if (announcedOnly) deposit(); // The old hand-start snapshot must be refreshed.
      const sourceEngine = Object.create(ServerTableEngine.prototype) as any;
      sourceEngine.tableId = source;
      sourceEngine.tableInfo = { cluster_id: 'game' };
      sourceEngine.lifecycleCanMutate = () => true;
      sourceEngine.isTournamentTable = () => false;
      sourceEngine.seatedPlayers = [{ user_id: player, occupancy_id: sourceStay, seat_number: 1 }];
      sourceEngine.heldForSwap = new Set();
      sourceEngine.announcedSeatMoves = new Set();
      sourceEngine.leaveHeldByClock = new Map();
      sourceEngine.timeBankMeta = new Map([[player, bank]]);
      sourceEngine.disconnectEngine = {
        getFsmState: () => ({ ...fsm, sinceMs: 2 }),
        unregisterPlayer: vi.fn(),
      };
      sourceEngine.timeBankEngine = {
        getPlayerBank: () => ({ ...bank, remainingSeconds: 7 }),
        removePlayer: vi.fn(),
      };
      sourceEngine.straddleEngine = { removePlayer: vi.fn() };
      sourceEngine.preActionEngine = { removePlayer: vi.fn() };
      sourceEngine.chipContinuity = { forget: vi.fn() };
      sourceEngine.broadcastCurrentState = vi.fn(async () => {});
      sourceEngine.wakeClusterGame = vi.fn();
      let resolve!: (value: moves.SeatMoveOutcome) => void;
      vi.spyOn(moves, 'executePendingSeatMoves').mockReturnValue(
        new Promise<moves.SeatMoveOutcome>((done) => {
          resolve = done;
        })
      );
      const candidate: moves.PendingSeatMove = {
        move_id: move,
        player_id: player,
        source_occupancy_id: sourceStay,
        to_table_id: table,
        to_table_name: null,
        to_role: null,
        to_main_index: null,
        reason: 'must_move',
        announced_at: announcedOnly ? '2026-09-15T13:00:00Z' : null,
        swap_move_id: null,
        ready_at: null,
      };
      const moving = sourceEngine.executePendingSeatMoves({ announcedOnly }, [candidate]);
      try {
        // The database has committed the chair while the source's reply is delayed.
        readers.arrivals.mockResolvedValue([arrival]);
        const destination = engineAtDestination();
        expect(await destination.adoptMovedPresence()).toBe(true);
        expect(destination.disconnectEngine.restoreFsmStates).toHaveBeenCalledWith(table, {
          [player]: { ...fsm, sinceMs: 2 },
        });
        expect(destination.timeBankEngine.initializePlayer).toHaveBeenCalledWith(
          table,
          player,
          expect.objectContaining({ remainingSeconds: 7 })
        );
      } finally {
        resolve({
          done: [
            {
              move_id: move,
              player_id: player,
              source_occupancy_id: sourceStay,
              destination_occupancy_id: destinationStay,
              source_seat_number: 1,
              to_table_id: table,
              to_seat_number: 2,
              stack: 25,
              reason: 'must_move',
              partner: null,
            },
          ],
          held: [],
          refused: [],
        });
        await moving;
      }
      expect(await moving).toEqual([player]);
    }
  );

  it('keeps distinct staged moves so an old reply cannot overwrite a later transfer', async () => {
    depositMovedPresence(player, table, {
      moveId: source,
      sourceOccupancyId: table,
      fromTableId: source,
      fsm: { ...fsm, sinceMs: 3 },
      timeBank: null,
    });
    deposit(); // Older move arrives late, after a different plan was staged.
    readers.arrivals.mockResolvedValue([
      { ...arrival, move_id: source, source_occupancy_id: table },
    ]);
    const engine = engineAtDestination();
    expect(await engine.adoptMovedPresence()).toBe(true);
    expect(engine.disconnectEngine.restoreFsmStates).toHaveBeenCalledWith(table, {
      [player]: { ...fsm, sinceMs: 3 },
    });
  });

  it('adopts presence and time bank from a confirmed move exactly once', async () => {
    deposit();
    readers.arrivals.mockResolvedValue([arrival]);
    const engine = engineAtDestination();
    expect(await engine.adoptMovedPresence()).toBe(true);
    expect(engine.disconnectEngine.restoreFsmStates).toHaveBeenCalledWith(table, { [player]: fsm });
    expect(engine.timeBankEngine.initializePlayer).toHaveBeenCalledWith(table, player, {
      remainingSeconds: 11,
      usesRemaining: 1,
      unlimitedActivations: false,
    });
    expect(engine.timeBankMeta.get(player)).toEqual({
      initialSeconds: 40,
      baseSeconds: 30,
      dbConsumedSeconds: 4,
    });
    expect(await engine.adoptMovedPresence()).toBe(true);
    expect(readers.arrivals).toHaveBeenCalledTimes(1);
    expect(engine.disconnectEngine.restoreFsmStates).toHaveBeenCalledTimes(1);
  });

  it('does not carry a cancelled plan into a later voluntary arrival', async () => {
    deposit();
    readers.arrivals.mockResolvedValue([]);
    const engine = engineAtDestination();
    expect(await engine.adoptMovedPresence()).toBe(true);
    expect(engine.disconnectEngine.restoreFsmStates).not.toHaveBeenCalled();
    expect(engine.timeBankEngine.initializePlayer).not.toHaveBeenCalled();
  });

  it.each([
    { ...arrival, move_id: source },
    { ...arrival, source_occupancy_id: source },
    { ...arrival, player_id: source },
  ])('rejects another transfer even at the same destination %#', async (proof) => {
    deposit();
    readers.arrivals.mockResolvedValue([proof]);
    const engine = engineAtDestination();
    expect(await engine.adoptMovedPresence()).toBe(true);
    expect(engine.disconnectEngine.restoreFsmStates).not.toHaveBeenCalled();
    expect(hasMovedPresence(player, table)).toBe(true);
  });

  it('does not adopt into a replacement occupancy after a delayed read', async () => {
    deposit();
    let resolve!: (value: (typeof arrival)[]) => void;
    readers.arrivals.mockReturnValue(
      new Promise<(typeof arrival)[]>((done) => {
        resolve = done;
      })
    );
    const engine = engineAtDestination();
    const adopting = engine.adoptMovedPresence();
    engine.seatedPlayers = [{ user_id: player, occupancy_id: source }];
    resolve([arrival]);
    expect(await adopting).toBe(true);
    expect(engine.disconnectEngine.restoreFsmStates).not.toHaveBeenCalled();
    expect(hasMovedPresence(player, table)).toBe(true);
  });

  it('withdraws a pending adoption when the engine stops', async () => {
    deposit();
    let resolve!: (value: (typeof arrival)[]) => void;
    readers.arrivals.mockReturnValue(
      new Promise<(typeof arrival)[]>((done) => {
        resolve = done;
      })
    );
    const engine = engineAtDestination();
    const adopting = engine.adoptMovedPresence();
    engine.lifecycleCanMutate.mockReturnValue(false);
    resolve([arrival]);
    expect(await adopting).toBe(false);
    expect(engine.disconnectEngine.restoreFsmStates).not.toHaveBeenCalled();
  });

  it('defers registration on an unknown read and recovers the same deposit later', async () => {
    deposit();
    readers.arrivals.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([arrival]);
    const engine = engineAtDestination();
    expect(await engine.adoptMovedPresence()).toBe(false);
    expect(engine.disconnectEngine.restoreFsmStates).not.toHaveBeenCalled();
    expect(hasMovedPresence(player, table)).toBe(true);
    expect(await engine.adoptMovedPresence()).toBe(true);
    expect(engine.disconnectEngine.restoreFsmStates).toHaveBeenCalledTimes(1);
  });

  it('does not request transfer history when no deposit exists', async () => {
    const engine = engineAtDestination();
    expect(await engine.adoptMovedPresence()).toBe(true);
    expect(readers.arrivals).not.toHaveBeenCalled();
  });
});
