/**
 * THE MANUAL "BOMB NEXT HAND" CLAIM IS NOT MADE AT A TOURNAMENT TABLE
 * (Horse Brain Phase 9.2, #5882).
 *
 * bombPotSettingsFromTable already reads the switch as off on a tournament
 * row, but the manual claim in ServerTableEngineDealing reads the raw
 * `bomb_pot_enabled` column and the pushed flag, not the scheduler settings.
 * Its own `!isTournamentTable()` term is the only thing between a host's
 * armed request and a bomb hand at a tournament table.
 *
 * Runs the REAL dealHand through configuration and HandController creation,
 * stopping at the first unrelated time-bank read, the way KillPotEngine and
 * TournamentBlindSnapshot do. The database answers the atomic claim with a
 * row, so a claim that is made is a claim that is won.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandController } from './HandController.js';

type TableWrite = {
  payload: Record<string, unknown> | undefined;
  filters: Array<[string, unknown]>;
  selected: boolean;
};

const { loadSeatedPlayers, loadTournamentBlinds, tableWrites, decideFast } = vi.hoisted(() => ({
  loadSeatedPlayers: vi.fn(),
  loadTournamentBlinds: vi.fn(),
  tableWrites: [] as TableWrite[],
  decideFast: vi.fn(
    (_snapshot: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('fixture turn retired')), {
          once: true,
        });
      })
  ),
}));
vi.mock('./horseDecision/index.js', async (original) => ({
  ...(await original<typeof import('./horseDecision/index.js')>()),
  getLiveHorseDecisionWorker: () => ({ decideFast }),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'tables') throw new Error(`Unexpected database access: ${table}`);
      const write: TableWrite = { payload: undefined, filters: [], selected: false };
      const builder: any = {
        update: (payload: Record<string, unknown>) => {
          write.payload = payload;
          tableWrites.push(write);
          return builder;
        },
        eq: (column: string, value: unknown) => {
          write.filters.push([column, value]);
          return builder;
        },
        select: () => {
          write.selected = true;
          return builder;
        },
        // The conditional UPDATE ... WHERE bomb_pot_manual_pending = true wins.
        maybeSingle: async () => ({ data: { id: 'claimed' }, error: null }),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve, reject),
      };
      return builder;
    },
    rpc: () => {
      throw new Error('Unexpected database RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadSeatedPlayers,
  loadTournamentBlinds,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.cancelHorseDecisionWork();
    engine.running = false;
    (ServerTableEngine as any).releaseCurrentEngine(engine.tableId, engine);
    engine.preciseTimer.dispose();
    engine.engineTelemetry.dispose();
  }
  loadSeatedPlayers.mockReset();
  loadTournamentBlinds.mockReset();
  decideFast.mockClear();
  tableWrites.length = 0;
  vi.restoreAllMocks();
});

const claimWrites = () =>
  tableWrites.filter((w) => w.payload && 'bomb_pot_manual_pending' in w.payload);

function fixture(kind: 'cash' | 'tournament') {
  const engine = new ServerTableEngine(
    'manual-bomb-' + kind + '-' + Math.random().toString(36).slice(2)
  ) as any;
  engines.push(engine);
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.running = true;
  engine.tableInfo = {
    id: engine.tableId,
    game_variant: 'nlh',
    game_type: kind,
    tournament_id: kind === 'tournament' ? 'tournament-manual-bomb' : null,
    max_players: 6,
    small_blind: 10,
    big_blind: 20,
    ante: 0,
    ante_enabled: false,
    // Bomb pots on, with a schedule that is nowhere near due, so the only
    // bomb this hand can be is the host's manual one.
    bomb_pot_enabled: true,
    bomb_pot_trigger_mode: 'every_n_hands',
    bomb_pot_frequency: 100,
    bomb_pot_min_players: 3,
    bomb_pot_board_count: 1,
    bomb_pot_ante_multiplier: 2,
  };
  const seats = [1, 2, 3, 4].map((seat) => ({
    seat_number: seat,
    user_id: 'u' + seat,
    username: 'Player ' + seat,
    occupancy_id: 'occupancy-' + seat,
    stack: 1000,
    seat_id: '00000000-0000-4000-8000-00000000000' + seat,
    seat_joined_at: '2026-09-10T00:00:00.123456Z',
  }));
  engine.seatedPlayers = seats;
  engine.dealtInUserIds = new Set(seats.map((s) => s.user_id));
  engine.lastButtonSeat = seats.length;
  engine.takePreparedHandNumber = () => 700 + engine.handsDealtThisSession;
  engine.bombPotSchedPersistedJson = 'null';
  engine.eventShadowEnabled = false;
  engine.hub = { emitEvent: vi.fn() };
  engine.refreshRakeConfig = async () => {};
  loadSeatedPlayers.mockResolvedValue(seats);
  loadTournamentBlinds.mockResolvedValue({ ...engine.tableInfo });
  // The host pressed "bomb next hand": fn_request_manual_bomb_pot set the
  // column and its broadcast armed the engine.
  engine.manualBombPushed = true;
  const prepared = new Error('hand controller prepared');
  engine.fetchTimeBankExtras = async () => {
    throw prepared;
  };
  async function deal(): Promise<{ hc: HandController; bombs: any[] }> {
    await expect(engine.dealHand(seats)).rejects.toBe(prepared);
    const hc: HandController = engine.handController;
    expect(hc).not.toBeNull();
    const bombs: any[] = [];
    hc.onEvent((event: any) => {
      if (event.type === 'BOMB_POT_TRIGGERED') bombs.push(event);
    });
    hc.start();
    return { hc, bombs };
  }
  return { engine, deal };
}

describe('the manual "bomb next hand" claim at a tournament table', () => {
  it('a tournament table deals no bomb, makes no claim and leaves the request untouched', async () => {
    const { engine, deal } = fixture('tournament');
    for (let hand = 0; hand < 2; hand++) {
      const { hc, bombs } = await deal();
      expect(bombs, 'hand ' + hand).toEqual([]);
      const state = hc.getState();
      expect(state.stage).toBe('preflop');
      // Ordinary blinds, not an everyone-antes bomb pot.
      expect(state.pot).toBe(30);
      expect(state.currentBet).toBe(20);
      expect((hc as any).config.bombPot).toBeUndefined();
      // No claim was attempted: the database flag is not consumed, the armed
      // flag is not disarmed, and no table row was written at all.
      expect(claimWrites()).toEqual([]);
      expect(tableWrites).toEqual([]);
      expect(engine.manualBombPushed).toBe(true);
    }
  });

  it('the same armed request on a cash table claims atomically and deals the bomb', async () => {
    const { engine, deal } = fixture('cash');
    const { hc, bombs } = await deal();
    expect(claimWrites()).toEqual([
      {
        payload: { bomb_pot_manual_pending: false },
        filters: [
          ['id', engine.tableId],
          ['bomb_pot_manual_pending', true],
        ],
        selected: true,
      },
    ]);
    expect(engine.manualBombPushed).toBe(false);
    expect(bombs).toHaveLength(1);
    expect(bombs[0]).toMatchObject({ triggerReason: 'manual_next_hand', anteAmount: 40 });
    // Everyone antes 2 x BB and the hand opens on the flop with nothing to call.
    expect(hc.getState()).toMatchObject({ pot: 160, currentBet: 0 });
  });
});
