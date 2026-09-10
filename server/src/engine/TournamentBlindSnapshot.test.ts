import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandController } from './HandController.js';

const { loadTable, loadSeatedPlayers } = vi.hoisted(() => ({
  loadTable: vi.fn(),
  loadSeatedPlayers: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw new Error('Unexpected database write');
    },
    rpc: () => {
      throw new Error('Unexpected database RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadTable,
  loadSeatedPlayers,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.preciseTimer.dispose();
  loadTable.mockReset();
  loadSeatedPlayers.mockReset();
  vi.restoreAllMocks();
});

const levelOne = { small_blind: 10, big_blind: 20, ante: 2 };
const levelTwo = { small_blind: 20, big_blind: 40, ante: 4 };

function fixture(count = 3) {
  const engine = new ServerTableEngine('tournament-level-snapshot') as any;
  engines.push(engine);
  engine.tableInfo = {
    id: engine.tableId,
    game_variant: 'nlh',
    game_type: 'tournament',
    tournament_id: 'tournament-level-boundary',
    max_players: 6,
    ...levelOne,
    ante_enabled: false,
  };
  const seats = Array.from({ length: count }, (_, index) => index + 1).map((seat) => ({
    seat_number: seat,
    user_id: 'u' + seat,
    username: 'Player ' + seat,
    occupancy_id: 'occupancy-' + seat,
    stack: 1000,
    seat_id: '00000000-0000-4000-8000-00000000000' + seat,
    seat_joined_at: '2026-09-10T00:00:00.123456Z',
  }));
  engine.seatedPlayers = seats;
  engine.takePreparedHandNumber = () => 100 + engine.handsDealtThisSession;
  engine.bombPotSchedPersistedJson = 'null';
  engine.eventShadowEnabled = false;
  engine.hub = { emitEvent: vi.fn() };
  // Cash rake is outside this tournament blind-boundary rehearsal.
  engine.refreshRakeConfig = async () => {};
  loadSeatedPlayers.mockResolvedValue(seats);
  loadTable.mockResolvedValue({ ...engine.tableInfo });
  // Run the real deal through configuration and HandController creation.
  // Stop at the first unrelated time-bank read, before settlement or transport.
  const prepared = new Error('hand controller prepared');
  engine.fetchTimeBankExtras = async () => {
    throw prepared;
  };
  async function deal(): Promise<HandController> {
    await expect(engine.dealHand(seats)).rejects.toBe(prepared);
    expect(engine.handController).not.toBeNull();
    return engine.handController;
  }
  return { engine, seats, deal };
}

describe('tournament levels belong to the hand that was created with them', () => {
  it('keeps an active hand at its old stakes and gives the next hand the new blinds and ante', async () => {
    const { engine, deal } = fixture();
    await engine.readNextHandInputs();
    const first = await deal();
    const completed = vi.fn();
    first.onEvent((event) => {
      if (event.type === 'HAND_COMPLETE') completed(event);
    });
    first.start();
    expect(first.getState()).toMatchObject({ stage: 'preflop', currentBet: 20, pot: 36 });

    // A level update arrives while this hand is still taking actions.
    loadTable.mockResolvedValue({ ...engine.tableInfo, ...levelTwo });
    await engine.refreshBlinds();
    expect(engine.tableInfo).toMatchObject(levelTwo);
    expect(first.getState()).toMatchObject({ currentBet: 20, pot: 36 });
    // The minimum legal opening raise still uses the old 20-chip big blind.
    expect(first.performAction(first.getState().currentPlayerSeat, 'raise', 40)).toBe(true);
    for (let folds = 0; folds < 2; folds++) {
      expect(first.performAction(first.getState().currentPlayerSeat, 'fold')).toBe(true);
    }
    expect(completed).toHaveBeenCalledOnce();
    expect(first.getState().players.reduce((sum, player) => sum + player.stack, 0)).toBe(3000);

    await engine.readNextHandInputs();
    const second = await deal();
    expect(second).not.toBe(first);
    second.start();
    expect(second.getState()).toMatchObject({ stage: 'preflop', currentBet: 40, pot: 72 });
    expect(second.performAction(second.getState().currentPlayerSeat, 'raise', 40)).toBe(false);
    expect(second.performAction(second.getState().currentPlayerSeat, 'raise', 80)).toBe(true);
  });

  it('waits for the new blind read before a prepared roster can start the next hand', async () => {
    const { engine, seats, deal } = fixture();
    let release!: (row: unknown) => void;
    loadTable.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    let ready = false;
    await expect(engine.readNextHandInputs()).resolves.toEqual(seats);
    const inputs = engine.awaitNextHandRest().then(() => {
      ready = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(engine.handController).toBeNull();
    release({ ...engine.tableInfo, ...levelTwo });
    await expect(inputs).resolves.toBeUndefined();
    const hand = await deal();
    hand.start();
    expect(hand.getState()).toMatchObject({ currentBet: 40, pot: 72 });
  });

  it('uses the level reached during the rest after next-hand inputs were prepared', async () => {
    const { engine, deal } = fixture();
    engine.allocateGlobalHandNumber = async () => 100;
    engine.armNextHandRest(60_000);
    await engine.prepareNextHand();
    let releaseRest!: () => void;
    const sleep = vi.spyOn(engine, 'sleep').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRest = resolve;
        })
    );
    const rest = engine.awaitNextHandRest();
    await Promise.resolve();
    await Promise.resolve();
    expect(sleep).toHaveBeenCalledOnce();
    loadTable.mockResolvedValue({ ...engine.tableInfo, ...levelTwo });
    releaseRest();
    await rest;
    expect(loadTable).toHaveBeenCalledOnce();
    const hand = await deal();
    hand.start();
    expect(hand.getState()).toMatchObject({ currentBet: 40, pot: 72 });
  });

  it('refuses the next deal when the blind authority cannot be read', async () => {
    const { engine } = fixture();
    const unavailable = new Error('blind authority rejected the read');
    loadTable.mockRejectedValue(unavailable);
    await engine.readNextHandInputs();
    await expect(engine.awaitNextHandRest()).rejects.toBe(unavailable);
    expect(engine.handController).toBeNull();
  });
});

describe('tournament sit-outs retain their forced-bet obligations', () => {
  it.each([2, 3, 6])(
    'keeps all %i absent entrants in blind rotation and charges their antes',
    async (count) => {
      const { engine, seats, deal } = fixture(count);
      for (const seat of seats) {
        engine.disconnectEngine.sitOut(
          engine.tableId,
          seat.user_id,
          'voluntary',
          Date.now() - 600_000
        );
      }
      expect(engine.dealableCount()).toBe(count);
      // The elapsed cash sit-out limit must not vacate a tournament occupancy.
      await engine.evictExpiredSitOuts({ countOrbit: true });
      expect(engine.seatedPlayers).toEqual(seats);
      // An established hand boundary avoids drawing a new heads-up first button.
      engine.lastButtonSeat = count;
      {
        const smallBlindSeat = engine.getSBSeatIndex();
        const bigBlindSeat = engine.getBBSeatIndex();
        const hand = await deal();
        hand.start();
        const state = hand.getState();
        expect(state.players).toHaveLength(count);
        expect(state.pot).toBe(30 + 2 * count);
        for (const player of state.players) {
          const blind = player.seat === smallBlindSeat ? 10 : player.seat === bigBlindSeat ? 20 : 0;
          expect(player.stack, 'forced bet at seat ' + player.seat).toBe(1000 - 2 - blind);
          expect(player.is_sitting_out).toBe(false);
        }
      }
      expect(engine.seatedPlayers).toEqual(seats);
    }
  );

  it('takes a short absent entrant all-in for the available ante instead of skipping the seat', async () => {
    const { engine, seats, deal } = fixture();
    seats[0].stack = 1;
    engine.disconnectEngine.sitOut(engine.tableId, seats[0].user_id);
    const hand = await deal();
    hand.start();
    expect(
      hand.getState().players.find((player) => player.user_id === seats[0].user_id)
    ).toMatchObject({
      stack: 0,
      is_all_in: true,
      is_sitting_out: false,
    });
    expect(hand.getState().pot).toBe(35);
  });

  it('keeps the cash exclusion scoped to cash tables', async () => {
    const { engine, seats } = fixture();
    engine.tableInfo.game_type = 'cash';
    engine.tableInfo.tournament_id = null;
    for (const seat of seats.slice(0, 2)) {
      engine.disconnectEngine.sitOut(engine.tableId, seat.user_id);
    }
    expect(engine.dealableCount()).toBe(1);
    await expect(engine.dealHand(seats)).resolves.toBeUndefined();
    expect(engine.handController).toBeNull();
  });

  it('refuses a prepared roster whose matching occupancy has a different exact seat generation', async () => {
    for (const changedGeneration of [
      { seat_id: '00000000-0000-4000-8000-000000000009' },
      { seat_joined_at: '2026-09-10T00:00:01.123456Z' },
    ]) {
      const { engine, seats } = fixture();
      const preparedRoster = seats.slice(0, 2).map((seat) => ({ ...seat }));
      const currentGeneration = { ...preparedRoster[0], ...changedGeneration };
      engine.seatedPlayers = [currentGeneration, preparedRoster[1], seats[2]];
      engine.takePreparedHandNumber = vi.fn();

      expect(currentGeneration).toMatchObject({
        user_id: preparedRoster[0].user_id,
        seat_number: preparedRoster[0].seat_number,
        occupancy_id: preparedRoster[0].occupancy_id,
      });
      await expect(engine.dealHand(preparedRoster)).resolves.toBeUndefined();
      expect(engine.takePreparedHandNumber).not.toHaveBeenCalled();
      expect(engine.handController).toBeNull();
    }
  });
});
