import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { TournamentManager } from './TournamentManager.js';
import { TableStateHub } from '../transport/TableStateHub.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { spinRuleManifest } from './SpinDrawReceipt.js';
import { spinPostRevealMs, spinRevealToDealMs } from '../config/spinSpec.js';
import { HEADS_UP_BLIND_STRUCTURE } from '../config/headsUpSpec.js';
import { deadlineScheduler } from '../engine/DeadlineScheduler.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';

const { from, rpc, reportError } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from, rpc },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError }));

const EVENT = 'c3000000-0000-4000-8000-000000000001';
const TABLE = 'c4000000-0000-4000-8000-000000000001';
const LEASE = 'c5000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const cleanup: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  from.mockReset();
  rpc.mockReset();
  reportError.mockReset();
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(
  options: {
    spin?: boolean;
    stack?: number;
    variant?: 'nlh' | 'plo4';
    setupDelay?: number;
    earlyEmitFailure?: boolean;
    rejectDraw?: boolean;
    completionDelay?: number;
    rejectCompletion?: boolean;
    preseatLead?: number;
    entrants?: number;
    timed?: boolean;
    satellite?: boolean;
    resume?: boolean;
    realClock?: boolean;
    resumeOnBreak?: boolean;
    resumeRebuild?: boolean;
    breakClearGate?: Promise<void>;
  } = {}
) {
  const spin = options.spin !== false;
  const stack = options.stack ?? 1000;
  const count = spin || options.timed ? 3 : 2;
  const seats = Array.from({ length: options.entrants ?? count }, (_, index) => ({
    user_id: 'c1000000-0000-4000-8000-00000000000' + (index + 1),
    seat_number: index + 1,
    table_id: TABLE,
    stack,
    occupancy_id: 'occupancy-' + index,
    seat_id: 'c6000000-0000-4000-8000-00000000000' + (index + 1),
    seat_joined_at: new Date(NOW).toISOString(),
    username: 'Player ' + index,
    is_horse: false,
  }));
  const row: any = {
    id: EVENT,
    variant: options.timed
      ? options.satellite
        ? 'satellite'
        : 'freezeout'
      : spin
        ? 'spin'
        : 'sng',
    tournament_type: options.timed
      ? options.satellite
        ? 'SATELLITE'
        : 'MTT'
      : spin
        ? 'SPIN'
        : 'SNG',
    format_contract: options.timed ? 'mtt-v1' : spin ? 'spin-v1' : 'sng-v1',
    game_type: options.variant ?? 'nlh',
    max_players: options.timed ? 200 : count,
    min_players: count,
    status: options.resume ? 'RUNNING' : 'REGISTERING',
    starting_chips: stack,
    buy_in_amount: spin ? 1 : 0.95,
    buy_in_fee: spin ? 0 : 0.05,
    prize_pool: spin ? 3 : 1.9,
    blind_structure: options.timed
      ? [{ smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 10 }]
      : HEADS_UP_BLIND_STRUCTURE,
    payout_structure: [{ place: 1, percentage: 100 }],
    start_time: options.preseatLead ? new Date(NOW + options.preseatLead).toISOString() : null,
    started_at: options.resume ? new Date(NOW + (options.preseatLead ?? 0)).toISOString() : null,
    level_started_at: options.resumeOnBreak ? new Date(NOW - 600_000).toISOString() : null,
    on_break: options.resumeOnBreak ?? false,
    break_started_at: options.resumeOnBreak ? new Date(NOW - 300_000).toISOString() : null,
    break_ends_at: options.resumeOnBreak ? new Date(NOW - 1000).toISOString() : null,
    current_level: 0,
  };
  const table = {
    id: TABLE,
    tournament_id: EVENT,
    game_type: 'tournament',
    game_variant: options.variant ?? 'nlh',
    max_players: count,
    current_players: count,
    status: 'running',
    small_blind: 10,
    big_blind: 20,
    ante: 0,
    action_time_seconds: 15,
  };
  const roster = seats.map((seat) => ({ ...seat, chips: stack, status: 'playing' }));
  const journal = [{ multiplier: 10, buy_in: 1, seats: 3, house_rake: 0.24 }];
  const entitlements = seats.map((seat) => ({
    user_id: seat.user_id,
    gross: 1,
    created_at: new Date(NOW).toISOString(),
  }));
  from.mockImplementation((relation: string) => {
    let patch: any;
    let singular = false;
    let head = false;
    const builder: any = {
      select(_projection: string, opts?: any) {
        head = !!opts?.head;
        return builder;
      },
      eq() {
        return builder;
      },
      in() {
        return builder;
      },
      is() {
        return builder;
      },
      update(value: any) {
        patch = value;
        return builder;
      },
      maybeSingle() {
        singular = true;
        return builder;
      },
      then(resolve: any, reject: any) {
        if (patch) Object.assign(row, structuredClone(patch));
        let value: any;
        switch (relation) {
          case 'tournaments':
            value = structuredClone(row);
            break;
          case 'tournament_players':
            value = structuredClone(roster);
            break;
          case 'tournament_refund_entitlements':
            value = entitlements;
            break;
          case 'tables':
            value = options.resumeRebuild ? [] : [table];
            break;
          case 'table_seats':
            value = seats.map((seat) => ({ ...seat, tables: table }));
            break;
          case 'spin_reserve_ledger':
            value = journal;
            break;
          default:
            throw new Error('Unexpected relation ' + relation);
        }
        const response = {
          data:
            head || (patch && !singular)
              ? null
              : singular && Array.isArray(value)
                ? value[0]
                : value,
          count: head ? roster.length : null,
          error: null,
        };
        const gate =
          relation === 'tournaments' && patch?.on_break === false
            ? options.breakClearGate
            : undefined;
        return Promise.resolve(gate)
          .then(() => response)
          .then(resolve, reject);
      },
    };
    return builder;
  });
  let launchId = '';
  let admittedStart = new Date(NOW).toISOString();
  let completedAt = 0;
  const rule_manifest = spinRuleManifest(1, stack);
  const tier = rule_manifest.tiers.find((candidate) => candidate.multiplier === 10)!;
  rpc.mockImplementation(async (name: string, args: any) => {
    if (name === 'fn_f06_hand_number_state' || name === 'fn_f06_allocate_hand_number') {
      expect(args).toEqual({
        p_tournament_id: EVENT,
        p_lease_generation: LEASE,
        p_table_id: TABLE,
      });
      return {
        error: null,
        data:
          name === 'fn_f06_hand_number_state'
            ? {
                ok: true,
                table_id: TABLE,
                lifecycle: '1',
                can_reserve: true,
                blocked_reason: null,
                used_hand_number_max: '1000000',
                next_hand_number_candidate: '1000001',
                unresolved_permit: null,
              }
            : {
                ok: true,
                table_id: TABLE,
                lifecycle: '1',
                hand_number: '1000001',
                hand_number_high_water: '1000000',
              },
      };
    }
    if (name === 'fn_f06_begin_hand') {
      expect(args).toMatchObject({
        p_tournament_id: EVENT,
        p_lease_generation: LEASE,
        p_table_id: TABLE,
        p_lifecycle: '1',
        p_hand_number: '1000001',
      });
      return {
        error: null,
        data: {
          ok: true,
          tournament_id: EVENT,
          generation: LEASE,
          table_id: TABLE,
          lifecycle: '1',
          hand_number: '1000001',
          permit_id: args.p_permit_id,
          custody_id: args.p_custody_id,
          state: 'reserved',
        },
      };
    }
    if (name === 'fn_begin_tournament_launch_atomic') {
      launchId = args.p_launch_id;
      admittedStart = args.p_started_at ?? admittedStart;
      return {
        error: null,
        data: {
          ok: true,
          claimed: true,
          completed: false,
          replay: false,
          launch_id: launchId,
          started_at: admittedStart,
          lease_generation: LEASE,
          format_contract: row.format_contract,
        },
      };
    }
    if (name === 'fn_spin_draw_and_settle_atomic') {
      if (options.rejectDraw)
        return { data: { ok: false, reason: 'funding_unavailable' }, error: null };
      Object.assign(row, { spin_multiplier: 10, prize_pool: 10 });
      return {
        error: null,
        data: {
          ok: true,
          replay: false,
          tournament_id: EVENT,
          launch_id: launchId,
          buy_in: 1,
          multiplier: 10,
          prize_pool: 10,
          pool_covered: 10,
          operator_shortfall: 0,
          starting_chips: stack,
          blind_structure: tier.blind_structure,
          payout_structure: tier.payout_structure,
          locked: [],
          entrants: seats.map((seat, i) => ({
            user_id: seat.user_id,
            registration_id: 'entry-' + i,
          })),
          rule_manifest,
          rule_sha256: 'a'.repeat(64),
          rule_provenance: 'at_draw',
        },
      };
    }
    if (name === 'fn_complete_tournament_launch_atomic') {
      if (options.completionDelay)
        await new Promise((resolve) => setTimeout(resolve, options.completionDelay));
      if (options.rejectCompletion)
        return { error: null, data: { ok: false, reason: 'launch_short_field' } };
      completedAt = Date.now();
      row.status = 'RUNNING';
      row.started_at = admittedStart;
      return {
        error: null,
        data: {
          ok: true,
          completed: true,
          status: 'RUNNING',
          started_at: admittedStart,
          completed_at: new Date().toISOString(),
          lease_generation: LEASE,
          format_contract: row.format_contract,
        },
      };
    }
    throw new Error('Unexpected RPC ' + name);
  });

  const hub = new TableStateHub();
  let emitCalls = 0;
  vi.spyOn(tableStateHub, 'emitEvent').mockImplementation((tableId, payload) => {
    if ((payload as any).type === 'spin_reveal' && ++emitCalls === 1 && options.earlyEmitFailure) {
      throw new Error('early reveal transport unavailable');
    }
    return hub.emitEvent(tableId, payload);
  });
  function subscribe(id: string) {
    const frames: any[] = [];
    const subscriber = {
      id,
      readyState: 1,
      bufferedAmount: 0,
      send: (raw: string) => frames.push(JSON.parse(raw)),
    };
    hub.subscribe(TABLE, subscriber);
    return {
      frames,
      subscriber,
      reveals: () =>
        frames.filter((frame) => frame.type === 'EVENT' && frame.payload.type === 'spin_reveal'),
    };
  }
  const clients = seats.map((seat) => subscribe(seat.user_id));
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = table;
  engine.seatedPlayers = seats;
  engine.knownPlayerIds = new Set(seats.map((seat) => seat.user_id));
  engine.dealingLoopFirstIteration = false;
  engine.isCurrentEngine = () => true;
  engine.bombPotSchedPersistedJson = 'null';
  engine.eventShadowEnabled = false;
  engine.hub = hub;
  // Hydration/persistence are external boundaries. The real dealing loop,
  // dealHand, HandController, hand event routing and deadline timer stay intact.
  engine.prepareNextHand = async () => seats;
  // No prefetched number: exercise the manager-installed allocator and permit.
  engine.takePreparedHandNumber = () => null;
  engine.refreshRakeConfig = async () => {};
  engine.fetchTimeBankExtras = async () => new Map([[seats[0].user_id, 20]]);
  engine.restoreSitOutsFromSeats = () => {};
  engine.evictExpiredSitOuts = async () => {};
  engine.announcePendingSeatMoves = async () => true;
  engine.persistPresenceForRestart = async () => {};
  engine.awaitNextHandRest = async () => {};
  engine.broadcastCurrentState = async () => {};
  engine.persistHoleCardsWithRetry = async () => {};
  engine.flushSnapshot = async () => {};
  const realEvent = engine.handleHandEvent.bind(engine);
  const handStarts: number[] = [];
  engine.handleHandEvent = async (event: any, players: any, generation: any) => {
    if (event.type === 'HAND_START') handStarts.push(Date.now());
    // No hand settlement is being rehearsed in this timing acceptance.
    if (event.type === 'HAND_COMPLETE') return;
    return realEvent(event, players, generation);
  };
  const ownedEngines = new Map([[TABLE, engine]]);
  const ownedTables = new Set([TABLE]);
  const gameServer = {
    tableEngines: ownedEngines,
    tournamentOwnedTables: ownedTables,
    tournamentRetirementCustody: new TournamentRetirementCustody(),
    ownsTournamentTableEngine: (tableId: string, incumbent: ServerTableEngine) =>
      ownedTables.has(tableId) && ownedEngines.get(tableId) === incumbent,
  };
  const manager = new TournamentManager(
    EVENT,
    gameServer as any,
    LEASE,
    performance.now() + 120_000
  ) as any;
  const blindStarts: number[] = [];
  if (!options.realClock) manager.startBlindTimer = vi.fn(() => blindStarts.push(Date.now()));
  manager.startEliminationChecker = () => {};
  manager.reconcileTournamentEntryWindow = async () => {};
  manager.scheduleSpinPostReveal = () => {};
  manager.createTablesAndSeatPlayers = async () => {
    if (options.setupDelay) await new Promise((resolve) => setTimeout(resolve, options.setupDelay));
    manager.tableEngines.set(TABLE, engine);
  };
  manager.admitManagedTableEngine = vi.fn();
  manager.createManagedTableEngine = () => engine;
  manager.restoreDrawnFirstButtons = async () => {};
  manager.broadcast = async () => true;
  manager.breakApplies = async () => true;
  let dealing: Promise<void> | undefined;
  engine.ready = Promise.resolve(true);
  engine.start = vi.fn(() => {
    if (!options.resume) expect(completedAt).toBeGreaterThan(0);
    engine.running = true;
    dealing = engine.dealingLoop();
    return dealing;
  });
  vi.spyOn(manager, 'startManagedTableEngine');
  manager.drainTableEngineStartJobs = async () => {};
  cleanup.push(() => {
    manager.running = false;
    engine.running = false;
    engine.activeHandWaitRelease?.release('test_cleanup');
    engine.preciseTimer.dispose();
    deadlineScheduler.cancelAll(TABLE);
  });
  return {
    manager,
    engine,
    row,
    roster,
    seats,
    clients,
    subscribe,
    hub,
    handStarts,
    blindStarts,
    started: options.resume ? manager.resume() : manager.start(),
    completedAt: () => completedAt,
    dealing: () => dealing,
  };
}

async function settle() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function expectNoHand(f: ReturnType<typeof fixture>) {
  expect(f.handStarts).toEqual([]);
  expect(f.engine.handController).toBeNull();
  for (const seat of f.seats)
    expect(f.engine.preciseTimer.hasTimer(TABLE, seat.user_id)).toBe(false);
}

async function expectFirstHand(f: ReturnType<typeof fixture>, earliest: number) {
  expect(
    f.handStarts,
    reportError.mock.calls.map((c) => String(c[0]) + ' ' + c[1]).join('\n')
  ).toHaveLength(1);
  expect(f.handStarts[0]).toBeGreaterThanOrEqual(earliest);
  const state = f.engine.handController.getState();
  expect(state.stage).toBe('preflop');
  expect(state.players).toHaveLength(f.seats.length);
  const actor = state.players.find((player: any) => player.seat === state.currentPlayerSeat);
  expect(f.engine.preciseTimer.hasTimer(TABLE, actor.user_id)).toBe(false);
  await vi.advanceTimersByTimeAsync(f.engine.handStartSettleMs);
  expect(f.engine.preciseTimer.hasTimer(TABLE, actor.user_id)).toBe(true);
  expect(f.engine.playerTurnStartTime).toBe(f.handStarts[0] + f.engine.handStartSettleMs);
  expect(f.engine.playerTurnDuration).toBe(15);
}

describe('actual manager launch reaches the first hand and action timer after the shared reveal', () => {
  it.each([
    ['ordinary admission', {}],
    ['slow table setup', { setupDelay: spinRevealToDealMs() + 5000 }],
    ['failed early transport', { earlyEmitFailure: true }],
  ] as const)('%s', async (_name, options) => {
    const f = fixture(options);
    await settle();
    expectNoHand(f);
    if ('setupDelay' in options) await vi.advanceTimersByTimeAsync(options.setupDelay);
    await f.started;
    await settle();
    expect(f.manager.startManagedTableEngine).toHaveBeenCalledOnce();
    const reveal = f.clients[0].reveals().at(-1).payload;
    expect(reveal.multiplier).toBe(10);
    for (const client of f.clients) expect(client.reveals().at(-1).payload).toEqual(reveal);
    const hold = Math.max(NOW + spinRevealToDealMs(), Date.now() + spinPostRevealMs());
    expect(reveal.hold_until).toBe(hold);
    expect(f.engine.dealHoldUntilMs).toBe(hold);
    expect(f.blindStarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(hold - Date.now() - 1);
    expectNoHand(f);
    const reconnected = f.subscribe('reconnected');
    expect(reconnected.reveals().at(-1).payload).toMatchObject({
      multiplier: 10,
      reveal_at: reveal.reveal_at,
      hold_until: hold,
      replayed: true,
    });
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    await expectFirstHand(f, hold);
    expect(f.blindStarts).toEqual([hold]);
    const afterDeal = f.subscribe('after-deal');
    expect(afterDeal.reveals()).toHaveLength(0);
  });

  it('coalesces overlapping local start requests into one admitted first hand', async () => {
    const f = fixture({ spin: false });
    const overlappingStart = f.manager.start();
    await Promise.all([f.started, overlappingStart]);
    await settle();
    await expectFirstHand(f, NOW);
    expect(
      rpc.mock.calls.filter(([name]) => name === 'fn_begin_tournament_launch_atomic')
    ).toHaveLength(1);
    expect(
      rpc.mock.calls.filter(([name]) => name === 'fn_complete_tournament_launch_atomic')
    ).toHaveLength(1);
    expect(f.manager.startManagedTableEngine).toHaveBeenCalledOnce();
  });

  it('leaves a one-player Heads-Up field registering without a dealer or receipt', async () => {
    const f = fixture({ spin: false, entrants: 1 });
    await f.started;
    await settle();
    expectNoHand(f);
    expect(f.row.status).toBe('REGISTERING');
    expect(rpc).not.toHaveBeenCalled();
    expect(f.manager.startManagedTableEngine).not.toHaveBeenCalled();
    expect(f.blindStarts).toEqual([]);
  });

  it('starts immediately after a slow completion consumes the entire reveal hold', async () => {
    const delay = spinRevealToDealMs() + 5000;
    const f = fixture({ completionDelay: delay });
    await settle();
    expectNoHand(f);
    expect(f.blindStarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expectNoHand(f);
    expect(f.manager.startManagedTableEngine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await f.started;
    await settle();
    await expectFirstHand(f, NOW + delay);
    expect(f.blindStarts).toEqual([NOW + delay]);
  });

  it('preserves the advertised pre-seat lead for a non-Spin game', async () => {
    const f = fixture({ spin: false, preseatLead: 60_000 });
    await f.started;
    await settle();
    expectNoHand(f);
    expect(f.blindStarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(59_999);
    expectNoHand(f);
    await vi.advanceTimersByTimeAsync(1);
    await expectFirstHand(f, NOW + 60_000);
    expect(f.blindStarts).toEqual([NOW + 60_000]);
  });

  it('starts a timed MTT at the admitted instant even when preparation consumes part of the lead', async () => {
    const f = fixture({ spin: false, timed: true, preseatLead: 60_000, setupDelay: 20_000 });
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    await f.started;
    await vi.advanceTimersByTimeAsync(39_999);
    expectNoHand(f);
    expect(f.blindStarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expectFirstHand(f, NOW + 60_000);
    expect(f.blindStarts).toEqual([NOW + 60_000]);
  });

  it('restores the receipt hold on a replacement dealer before it can deal', async () => {
    const f = fixture({ spin: false, timed: true, preseatLead: 60_000 });
    await f.started;
    await settle();
    // A new dealer has no process-local hold. Exercise the actual replacement
    // preparation method before the existing real dealing loop wakes.
    f.engine.dealHoldUntilMs = 0;
    f.manager.prepareManagedTableEngineForPlay(f.engine);
    expect(f.engine.dealHoldUntilMs).toBe(NOW + 60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expectNoHand(f);
    await vi.advanceTimersByTimeAsync(1);
    await expectFirstHand(f, NOW + 60_000);
  });

  it.each([false, true])(
    'a replacement manager holds real cards and the clock until its persisted launch start (satellite=%s)',
    async (satellite) => {
      const f = fixture({
        spin: false,
        timed: true,
        resume: true,
        realClock: true,
        preseatLead: 60_000,
        satellite,
      });
      await f.started;
      await settle();
      expect(f.manager.running).toBe(true);
      expect(f.manager.startManagedTableEngine).toHaveBeenCalledOnce();
      expect(f.engine.dealHoldUntilMs).toBe(NOW + 60_000);
      expect(f.row.level_started_at).toBeNull();
      expect(f.manager.blindTimer).toBeNull();
      await f.manager.advanceBlindLevel(f.row.blind_structure);
      expect(f.manager.currentLevel).toBe(0);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual(['fn_f06_hand_number_state']);
      await vi.advanceTimersByTimeAsync(59_999);
      expectNoHand(f);
      expect(f.row.level_started_at).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await expectFirstHand(f, NOW + 60_000);
      expect(f.row.level_started_at).toBe(new Date(NOW + 60_000).toISOString());
      expect(f.manager.currentLevel).toBe(0);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual([
        'fn_f06_hand_number_state',
        'fn_f06_allocate_hand_number',
        'fn_f06_hand_number_state',
        'fn_f06_begin_hand',
      ]); // Resume proves hand authority without minting a new launch receipt.
    }
  );

  it.each([false, true])(
    'an earlier synchronized break preserves the actual timed first hand and full first level (satellite=%s)',
    async (satellite) => {
      const f = fixture({
        spin: false,
        timed: true,
        realClock: true,
        preseatLead: 60_000,
        satellite,
      });
      await f.started;
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await f.manager.pauseForBreak(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await f.manager.resumeFromBreak();
      expect(f.manager.onBreak).toBe(false);
      expect(f.row.level_started_at).toBeNull();
      expect(f.manager.blindTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(39_999);
      expectNoHand(f);
      expect(f.row.level_started_at).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await expectFirstHand(f, NOW + 60_000);
      expect(f.row.level_started_at).toBe(new Date(NOW + 60_000).toISOString());
      expect(f.manager.currentLevel).toBe(0);
    }
  );

  it.each([false, true])(
    'keeps a replacement dealer parked until its expired-break clock is acknowledged (rebuild=%s)',
    async (resumeRebuild) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = fixture({
        spin: false,
        timed: true,
        resume: true,
        realClock: true,
        resumeOnBreak: true,
        resumeRebuild,
        breakClearGate: gate,
      });
      try {
        await settle();
        expect(f.manager.startManagedTableEngine).toHaveBeenCalledOnce();
        expectNoHand(f);
        expect(f.manager.onBreak).toBe(true);
        expect(f.engine.pauseRequiresExplicitResume).toBe(true);
        expect(f.manager.blindTimer).toBeNull();
        release();
        await f.started;
        await settle();
        await expectFirstHand(f, NOW);
        expect(f.manager.onBreak).toBe(false);
        expect(f.manager.blindTimerStartedAt).toBe(Date.parse(f.row.level_started_at));
      } finally {
        release();
        await f.started;
      }
    }
  );

  it('does not arm a delayed Spin level after its owning lifecycle stops', async () => {
    const f = fixture();
    await f.started;
    await settle();
    f.manager.running = false;
    f.engine.running = false;
    await vi.advanceTimersByTimeAsync(spinRevealToDealMs() + 1000);
    expectNoHand(f);
    expect(f.blindStarts).toEqual([]);
  });

  it.each(['draw', 'completion'] as const)(
    'does not deal or start any clock when %s authority refuses admission',
    async (boundary) => {
      const f = fixture({
        rejectDraw: boundary === 'draw',
        rejectCompletion: boundary === 'completion',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await f.started;
      expectNoHand(f);
      expect(f.manager.startManagedTableEngine).not.toHaveBeenCalled();
      expect(f.blindStarts).toEqual([]);
    }
  );

  it.each([
    [300, 'nlh'],
    [300, 'plo4'],
    [1000, 'nlh'],
    [1000, 'plo4'],
  ] as const)('launches HU %i %s with a full first action clock', async (stack, variant) => {
    const f = fixture({ spin: false, stack, variant });
    await f.started;
    await settle();
    await expectFirstHand(f, NOW);
    expect(f.blindStarts).toEqual([NOW]);
    expect(f.manager.startBlindTimer).toHaveBeenCalledWith(HEADS_UP_BLIND_STRUCTURE);
    expect(HEADS_UP_BLIND_STRUCTURE.every((level) => level.durationMinutes === 3)).toBe(true);
    const state = f.engine.handController.getState();
    expect(state.currentBet).toBe(20);
    expect(state.pot).toBe(30);
    expect(state.currentPlayerSeat).toBe(state.dealerSeat);
    expect(state.players.map((p: any) => p.stack).sort((a: number, b: number) => a - b)).toEqual([
      stack - 20,
      stack - 10,
    ]);
    expect(state.players.every((p: any) => p.cards.length === (variant === 'nlh' ? 2 : 4))).toBe(
      true
    );
    expect(f.engine.timeBankEngine.getPlayerBank(TABLE, f.seats[0].user_id)).toMatchObject({
      remainingSeconds: 60,
      usesRemaining: 3,
    });
    expect(f.engine.timeBankEngine.getPlayerBank(TABLE, f.seats[1].user_id)).toMatchObject({
      remainingSeconds: 40,
      usesRemaining: 2,
    });
  });
});
