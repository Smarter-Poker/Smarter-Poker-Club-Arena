import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { HandController } from './HandController.js';
import { horseTournamentProvenanceMatchesSnapshot } from './HorseTournamentContextProvenance.js';
import type {
  FastHorseDecisionResult,
  LiveHorseDecisionSnapshot,
} from './horseDecision/protocol.js';
import * as tournamentContext from '../services/TournamentBrainContext.js';

const { loadTable, loadSeatedPlayers } = vi.hoisted(() => ({
  loadTable: vi.fn(),
  loadSeatedPlayers: vi.fn(),
}));
const { decideFast } = vi.hoisted(() => ({
  decideFast: vi.fn(
    (_snapshot: LiveHorseDecisionSnapshot, signal: AbortSignal) =>
      new Promise<FastHorseDecisionResult>((_resolve, reject) => {
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
import { F06HandPermit } from '../services/F06HandPermit.js';
import { MaintenanceBreak } from '../maintenance/MaintenanceBreak.js';
import { GameServer } from '../GameServer.js';

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.cancelHorseDecisionWork();
    engine.running = false;
    (ServerTableEngine as any).releaseCurrentEngine(engine.tableId, engine);
    engine.preciseTimer.dispose();
    engine.engineTelemetry.dispose();
  }
  loadTable.mockReset();
  loadSeatedPlayers.mockReset();
  decideFast.mockClear();
  vi.restoreAllMocks();
});

const levelOne = { small_blind: 10, big_blind: 20, ante: 2 };
const levelTwo = { small_blind: 20, big_blind: 40, ante: 4 };

function fixture(count = 3, tableId = 'tournament-level-snapshot') {
  const engine = new ServerTableEngine(tableId) as any;
  engines.push(engine);
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.running = true;
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
  it.each([false, true])(
    'keeps the Horse request on the dealt level until the next hand (big-blind ante: %s)',
    async (bigBlindAnte) => {
      const { engine, seats, deal } = fixture();
      engine.tableInfo.big_blind_ante_enabled = bigBlindAnte;
      engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'fixture-lease' });
      const capture = (hand: HandController): LiveHorseDecisionSnapshot => {
        const state = hand.getState();
        const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
        const seated = seats.find((p) => p.user_id === player.user_id)!;
        engine.scheduleHorseAction(seated, player.seat, player, state);
        expect(decideFast).toHaveBeenCalledOnce();
        const snapshot = decideFast.mock.calls[0]![0];
        expect(horseTournamentProvenanceMatchesSnapshot(snapshot)).toBe(true);
        expect(snapshot.gameState.tournament?.contextProvenance?.projection).toMatchObject({
          tableId: engine.tableId,
          handNumber: engine.handCount,
          actorId: player.user_id,
          actorSeat: player.seat,
          dealerSeat: state.dealerSeat,
          dealtSeatIds: state.players.map((p) => p.seat),
          gameVariant: 'nlh',
        });
        // The same actor and payload cannot borrow another table's turn fence.
        expect(
          horseTournamentProvenanceMatchesSnapshot({
            ...snapshot,
            fence: snapshot.fence.replace(`${engine.tableId}:`, 'another-table:'),
          })
        ).toBe(false);
        engine.cancelHorseDecisionWork();
        decideFast.mockClear();
        return snapshot;
      };
      const first = await deal();
      first.start();
      loadTable.mockResolvedValue({ ...engine.tableInfo, ...levelTwo });
      await engine.refreshBlinds();
      expect(engine.tableInfo).toMatchObject(levelTwo);
      const old = capture(first);
      expect(old.gameState).toMatchObject({
        bigBlind: 20,
        ante: 2,
        bigBlindAnte,
        minRaiseTo: 40,
        tournament: {
          currentSmallBlind: 10,
          currentBigBlind: 20,
          currentAnte: 2,
          anteType: bigBlindAnte ? 'big_blind' : 'per_player',
          // Ante 2 is authored per player; a BBA fronts all three shares.
          m: { orbitCostChips: 36 },
          contextProvenance: { projection: { smallBlind: 10, bigBlind: 20, ante: 2 } },
        },
      });
      for (let folds = 0; folds < 2; folds++) {
        expect(first.performAction(first.getState().currentPlayerSeat, 'fold')).toBe(true);
      }
      const second = await deal();
      second.start();
      expect(capture(second).gameState).toMatchObject({
        bigBlind: 40,
        ante: 4,
        bigBlindAnte,
        minRaiseTo: 80,
        tournament: {
          currentSmallBlind: 20,
          currentBigBlind: 40,
          currentAnte: 4,
          m: { orbitCostChips: 72 },
          contextProvenance: { projection: { smallBlind: 20, bigBlind: 40, ante: 4 } },
        },
      });
    }
  );

  it.each(['blinds', 'small_blind', 'ante', 'ante_type'])(
    'retains a complete cached source when %s differs from the actual dealt hand',
    async (changed) => {
      const { engine, seats, deal } = fixture();
      engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'fixture-lease' });
      const hand = await deal();
      hand.start();
      const now = Date.now();
      // Synthetic source rows exercise the real context derivation and scheduler.
      // This is not a live database read or an atomic database-snapshot proof.
      const context = tournamentContext.deriveContext(
        {
          format_contract: 'mtt-v1',
          effective_max_players: 100,
          tournament_type: 'MTT',
          status: 'RUNNING',
          game_type: 'NLH',
          variant: 'freezeout',
          max_players: 100,
          table_size: 6,
          payout_structure: [{ place: 1, percentage: 100 }],
          prize_pool: 100,
          bounty_pool: 0,
          is_pko: false,
          is_bounty: false,
          is_mystery_bounty: false,
          blind_structure: [
            {
              level: 1,
              smallBlind: changed === 'blinds' || changed === 'small_blind' ? 20 : 10,
              bigBlind: changed === 'blinds' ? 40 : 20,
              ante: changed === 'blinds' || changed === 'ante' ? 4 : 2,
              durationMinutes: 10,
            },
          ],
          current_level: 0,
          level_started_at: new Date(now - 60_000).toISOString(),
          started_at: new Date(now - 120_000).toISOString(),
          late_reg_mins: 0,
          late_reg_levels: 0,
          is_reentry: false,
          max_reentries: 0,
          is_rebuy: false,
          rebuy_levels: 0,
          max_rebuys: 0,
          add_on_available: false,
          addon_period_triggered: false,
          prize_pool_finalized: false,
          on_break: false,
          accelerated_mtt: false,
          big_blind_ante: changed === 'ante_type',
          authorized_to_register: false,
        },
        3,
        3,
        3000,
        [1000, 1000, 1000],
        [],
        [],
        0,
        {},
        now
      );
      expect(context.contextStatus).toBe('complete');
      const cached: tournamentContext.TournamentBrainContextSnapshot = {
        context,
        status: 'complete',
        issues: [],
        ageMs: 0,
        contextProvenance: {
          version: 1,
          readAtMs: now,
          status: 'complete',
          issues: [],
          ageMs: 0,
          source: {
            version: 1,
            tournamentId: engine.tableInfo.tournament_id,
            cacheId: 'aaaaaaaa-0000-4000-8000-000000000001',
            generation: 1,
            readStartedAtMs: now - 10,
            readCompletedAtMs: now,
            contextDigest: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
            contextStatus: 'complete',
            contextIssues: [],
          },
        },
      };
      vi.spyOn(tournamentContext, 'getTournamentBrainContextSnapshot').mockReturnValue(cached);
      loadTable.mockResolvedValue({ ...engine.tableInfo, ...levelTwo });
      await engine.refreshBlinds();
      const state = hand.getState();
      const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
      engine.scheduleHorseAction(
        seats.find((p) => p.user_id === player.user_id)!,
        player.seat,
        player,
        state
      );
      expect(decideFast).toHaveBeenCalledOnce();
      const request = decideFast.mock.calls[0]![0];
      expect(horseTournamentProvenanceMatchesSnapshot(request)).toBe(true);
      expect(request.gameState).toMatchObject({
        bigBlind: 20,
        ante: 2,
        tournament: {
          contextStatus: 'incomplete',
          contextIssues: ['TOURNAMENT_CONTEXT_INCOMPLETE', 'blind_level_cache_lag'],
          currentSmallBlind: 10,
          currentBigBlind: 20,
          currentAnte: 2,
          m: { orbitCostChips: 36 },
          contextProvenance: {
            status: 'complete',
            issues: [],
            source: cached.contextProvenance.source,
            projection: { smallBlind: 10, bigBlind: 20, ante: 2 },
          },
        },
      });
      expect(cached.status).toBe('complete');
      expect(cached.context?.contextStatus).toBe('complete');
      expect(cached.contextProvenance.source?.contextStatus).toBe('complete');
      expect(cached.context?.currentBigBlind).toBe(changed === 'blinds' ? 40 : 20);
      expect(cached.issues).toEqual([]);
    }
  );

  it('binds the observation cache reader to the dealt tournament before table reassignment', async () => {
    const read = vi.spyOn(tournamentContext, 'getTournamentBrainContextSnapshot').mockReturnValue({
      context: null,
      status: 'warming',
      issues: ['warming'],
      ageMs: null,
      contextProvenance: {
        version: 1,
        readAtMs: 1000,
        status: 'warming',
        issues: ['TOURNAMENT_CONTEXT_INCOMPLETE', 'tournament_context_warming'],
        ageMs: null,
        source: null,
      },
    });
    const { engine, deal } = fixture();
    const hand = await deal();
    expect(read).not.toHaveBeenCalled();
    engine.tableInfo.tournament_id = 'a-later-table-assignment';
    const actions: any[] = [];
    hand.onEvent((event) => {
      if (event.type === 'PLAYER_ACTION') actions.push(event);
    });
    hand.start();
    expect(hand.performAction(hand.getState().currentPlayerSeat, 'call', undefined, 'player')).toBe(
      true
    );
    expect(read).toHaveBeenCalledWith('tournament-level-boundary');
    expect(read).toHaveBeenCalledTimes(1);
    expect(actions[0].publicNode).toMatchObject({
      status: 'captured',
      tournamentStage: { status: 'unavailable', reason: 'context_warming' },
    });
  });

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
});

describe('a pause arriving while the controller is being prepared', () => {
  it.each([
    ['maintenance', (e: any) => e.pauseForMaintenance(300_000)],
    ['deal discussion', (e: any) => e.pauseForFinalTableDeal(60_000)],
    ['synchronized break', (e: any) => e.pauseAfterHand(420_000, { beforeNextHand: true })],
    ['operator', (e: any) => e.adminPause()],
  ] as const)('discards the unstarted controller for %s', async (_name, arm) => {
    const { engine, seats } = fixture();
    engine.running = true;
    engine.isCurrentEngine = () => true;
    const start = vi.fn(() => {
      throw new Error('unexpected hand start');
    });
    engine.fetchTimeBankExtras = async () => {
      engine.handController.start = start;
      arm(engine);
      return new Map();
    };
    await engine.dealHand(seats);
    expect(start).not.toHaveBeenCalled();
    expect(engine.handController).toBeNull();
    expect(engine.currentHandDealtStacks.size).toBe(0);
  });
});

describe('maintenance crossing an original F06 reservation', () => {
  it.each(['receipt', 'lost reply'] as const)(
    'drains the original preparation before maintenance restart: %s',
    async (outcome) => {
      const identity = {
        tournament_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        lease_generation: 'bbbbbbbb-0000-4000-8000-000000000001',
        table_id: 'cccccccc-0000-4000-8000-000000000001',
        lifecycle: '1',
        permit_id: 'dddddddd-0000-4000-8000-000000000001',
        hand_number: '100',
        custody_id: 'eeeeeeee-0000-4000-8000-000000000001',
      };
      const { engine, seats } = fixture(3, identity.table_id);
      engine.tableInfo.tournament_id = identity.tournament_id;
      let persisted: Record<string, unknown> | null = null;
      let releaseBegin!: () => void;
      const beginReturned = new Promise<void>((resolve) => {
        releaseBegin = resolve;
      });
      let entered!: () => void;
      const beginEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let releaseCancel!: () => void;
      const cancelReturned = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      let enteredCancel!: () => void;
      const cancelEntered = new Promise<void>((resolve) => {
        enteredCancel = resolve;
      });
      const rpc = vi.fn(async (name: string) => {
        if (name === 'fn_f06_cancel_prepared_hand') {
          expect(permit.recoveryState()).toBe('terminated');
          expect(engine.handController).toBeNull();
          persisted = { ...persisted, state: 'never_started', evidence_id: identity.permit_id };
          enteredCancel();
          await cancelReturned;
          if (outcome === 'lost reply') return { data: null, error: new Error('lost reply') };
          return { data: { ...persisted, ok: true }, error: null };
        }
        expect(name).toBe('fn_f06_begin_hand');
        persisted = {
          ...identity,
          generation: identity.lease_generation,
          state: 'reserved',
          evidence_id: null,
        };
        entered();
        await beginReturned;
        return { data: { ...persisted, ok: true }, error: null };
      });
      const permit = new F06HandPermit(identity, rpc, () => true);
      engine.running = false;
      engine.installF06HandAdmission(() => permit);
      engine.running = true;
      // Persistence unrelated to this original permit is excluded by the existing
      // fixture. The real pause, reserve, deal continuation and stop remain intact.
      engine.persistPresenceForRestart = vi.fn(async () => {});
      const snapshot = vi.spyOn(engine, 'saveSnapshot');
      const maintenance = new MaintenanceBreak({
        engines: () => new Map<string, ServerTableEngine>([[engine.tableId, engine]]).entries(),
        isRunning: () => true,
        emit: () => {},
        store: {} as any,
      });
      // Provider persistence is the test boundary; the actual restart predicate,
      // real engine and exact F06 permit remain connected.
      Object.assign(maintenance, {
        phase: 'counting_down',
        durableConfirmed: true,
        breakEndsAt: Date.now() + 300_000,
      });
      const server = Object.create(GameServer.prototype) as GameServer;
      Object.assign(server, { tableEngines: new Map([[engine.tableId, engine]]) });
      const preparation = engine.dealHand(seats);
      const settled = preparation.then(
        () => null,
        (error: unknown) => error
      );
      await beginEntered;
      engine.pauseForMaintenance(300_000);
      releaseBegin();
      await cancelEntered;
      expect(engine.hasUnresolvedF06Preparation()).toBe(true);
      expect(maintenance.readyForRestart()).toBe(false);
      expect(await server.drainHands(0)).toMatchObject({ timedOut: true, drained: 0 });
      // Stop cannot turn an unacknowledged cancellation into restart readiness.
      await engine.stop();
      expect(engine.isRunning()).toBe(false);
      expect(maintenance.readyForRestart()).toBe(false);
      expect(await server.drainHands(0)).toMatchObject({ timedOut: true, drained: 0 });
      releaseCancel();
      const error = await settled;
      if (outcome === 'lost reply') {
        expect(String(error)).toContain('f06_prepared_cancellation_unknown');
        expect(engine.hasUnresolvedF06Preparation()).toBe(true);
        expect(maintenance.readyForRestart()).toBe(false);
        expect(await server.drainHands(0)).toMatchObject({ timedOut: true, drained: 0 });
        expect(() => permit.start(() => {})).toThrow('f06_start_unproven');
        return;
      }
      expect(error).toBeNull();
      expect(maintenance.readyForRestart()).toBe(true);
      expect(await server.drainHands(0)).toMatchObject({ timedOut: false, drained: 1 });
      expect(engine.handController).toBeNull();
      expect(engine.handsDealtThisSession).toBe(0);
      expect(snapshot).not.toHaveBeenCalled();
      expect(engine.getF06RetainedPermit()).toBeNull();
      await engine.stop();
      expect(engine.hasReleasedProcessOwnership()).toBe(true);
      // A process-local phase cannot clear this durable obstruction at restart.
      expect(persisted).toMatchObject({ state: 'never_started', evidence_id: identity.permit_id });
      expect(rpc.mock.calls.map(([name]) => name)).toEqual([
        'fn_f06_begin_hand',
        'fn_f06_cancel_prepared_hand',
      ]);
    }
  );
});
