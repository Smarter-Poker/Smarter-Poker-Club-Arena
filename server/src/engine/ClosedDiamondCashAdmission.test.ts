import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engines = vi.hoisted(() => ({
  created: [] as any[],
  start: vi.fn(),
  stop: vi.fn(),
}));

// The actual Base startup fence is covered in EngineStartResilience. This
// double controls physical stop settlement at the GameServer ownership seam.
vi.mock('./ServerTableEngine.js', () => ({
  ServerTableEngine: class {
    ready: Promise<boolean>;
    resolveReady!: (ready: boolean) => void;
    policy: unknown = null;
    running = false;
    released = false;

    constructor(
      readonly tableId: string,
      readonly authority: unknown
    ) {
      this.ready = new Promise((resolve) => {
        this.resolveReady = resolve;
      });
      engines.created.push(this);
    }

    setHub() {}
    onRestartRequired() {
      return () => {};
    }
    start() {
      return engines.start(this);
    }
    stop() {
      return engines.stop(this);
    }
    isRunning() {
      return this.running;
    }
    hasReleasedProcessOwnership() {
      return this.released;
    }
    getEngineLeaseAuthority() {
      return this.authority;
    }
    getStartupPolicyRefusal() {
      return this.policy;
    }
  },
}));

import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase/client.js';
import { loadTable } from '../services/supabase/tables.js';
import * as leases from '../services/tableLease.js';
import * as errors from '../services/errorReporter.js';
import { DiamondCashPolicyClosedError } from '../services/cashTablePlayEligibility.js';

const TABLE = '42dbb91d-42b5-4b6d-af41-86b08203b9cd';
const ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';
const GENERATION = 'bd57d3ad-a3b3-4027-875d-25772b24c70f';
const row = {
  id: TABLE,
  club_id: ARENA,
  union_id: null,
  tournament_id: null,
  arena: { id: ARENA, asset: 'diamonds', is_platform: true, union_id: null },
  game_type: 'cash',
  status: 'waiting',
  is_deleted: false,
  game_variant: 'nlh',
  is_template: false,
  cluster_id: null,
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 20,
  max_buy_in: 200,
  ante: 0,
  rake_percent: 0,
  rake_cap_bb: 0,
  bbj_percent: 0,
  run_it_twice: false,
  allow_run_it_twice: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const servers: any[] = [];
function bareServer(): any {
  const server = Object.create(GameServer.prototype) as any;
  Object.assign(server, {
    running: true,
    lifecycleGeneration: 7,
    dealerPrerequisitesReady: true,
    dealerPrerequisiteGate: null,
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tableEngineStartPromises: new Map(),
    directTableAdmissionOperations: new Map(),
    directTableAdmissionLeaseGenerations: new Map(),
    directTablePendingLeaseReleases: new Map(),
    directTableRecoveryTimers: new Map(),
    directTableRecoveryAttempts: new Map(),
    directTableEngineRecoveries: new WeakMap(),
    directTableEngineRecoveryJobs: new Set(),
    engineStartFailures: 0,
    maintenanceBreak: { adopt: vi.fn() },
  });
  servers.push(server);
  return server;
}

function database(table: unknown, settings: () => unknown | Promise<unknown>) {
  return vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
    if (relation !== 'tables' && relation !== 'ca_arena_settings') {
      throw new Error('Unexpected database read: ' + relation);
    }
    const chain: any = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () =>
        relation === 'tables' ? { data: table, error: null } : settings()
      ),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    return chain;
  }) as any);
}

async function settleMicrotasks() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  engines.created.length = 0;
  engines.start.mockReset();
  engines.stop.mockReset();
  vi.spyOn(errors, 'reportError').mockImplementation(() => {});
  vi.spyOn(leases, 'claimTableLease').mockResolvedValue({
    status: 'granted',
    leaseGeneration: GENERATION,
    proofDeadlineMonotonicMs: performance.now() + 60_000,
  } as any);
  vi.spyOn(leases, 'releaseTables').mockResolvedValue({
    status: 'confirmed',
    attempts: 1,
    released: 1,
  } as any);
  engines.start.mockImplementation(async (engine: any) => {
    try {
      await loadTable(engine.tableId);
      engine.running = true;
      engine.resolveReady(true);
    } catch (error) {
      if (error instanceof DiamondCashPolicyClosedError) {
        engine.policy = { code: error.code, tableId: error.tableId, arenaId: error.arenaId };
      }
      engine.resolveReady(false);
      throw error;
    }
  });
  engines.stop.mockImplementation(async (engine: any) => {
    engine.released = true;
  });
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.running = false;
    for (const tableId of server.directTableRecoveryTimers.keys())
      server.clearDirectTableRecovery(tableId);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('closed Diamond cash admission', () => {
  it('collapses concurrent closed admissions before any lease, engine or retry', async () => {
    const settings = deferred<unknown>();
    const from = database(row, () => settings.promise);
    const server = bareServer();
    const first = server.ensureCashTableEngineAdmission(TABLE);
    const second = server.ensureCashTableEngineAdmission(TABLE);
    await settleMicrotasks();
    expect(server.directTableAdmissionOperations.size).toBe(1);
    expect(from.mock.calls.filter(([name]) => name === 'ca_arena_settings')).toHaveLength(1);
    expect(leases.claimTableLease).not.toHaveBeenCalled();

    settings.resolve({ data: { club_id: ARENA, cash_games_enabled: false }, error: null });
    await expect(first).resolves.toBe('policy_closed');
    await expect(second).resolves.toBe('policy_closed');
    server.finishDirectTableAdmission(TABLE, 'test', 'policy_closed');
    expect(engines.created).toHaveLength(0);
    expect(leases.claimTableLease).not.toHaveBeenCalled();
    expect(leases.releaseTables).not.toHaveBeenCalled();
    expect(server.directTableRecoveryTimers.size).toBe(0);
    expect(errors.reportError).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: [], error: null },
    { data: { club_id: ARENA }, error: null },
    { data: { club_id: ARENA, cash_games_enabled: 'false' }, error: null },
    { data: { club_id: 'other', cash_games_enabled: false }, error: null },
    { data: { club_id: ARENA, cash_games_enabled: false }, error: { message: 'supabase_timeout' } },
  ])('keeps unavailable policy actionable and never claims: %j', async (settings) => {
    database(row, () => settings);
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('retryable_failure');
    server.finishDirectTableAdmission(TABLE, 'test', 'retryable_failure');
    expect(errors.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.cash_table_play_eligibility_unavailable',
      { tableId: TABLE }
    );
    expect(leases.claimTableLease).not.toHaveBeenCalled();
    expect(engines.created).toHaveLength(0);
    expect(server.directTableRecoveryTimers.size).toBe(1);
  });

  it('does not treat a malformed arena identity as a closed or open arena', async () => {
    const from = database({ ...row, arena: null }, () => {
      throw new Error('settings must not be read without identity');
    });
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('retryable_failure');
    expect(from.mock.calls.filter(([name]) => name === 'ca_arena_settings')).toHaveLength(0);
    expect(errors.reportError).toHaveBeenCalled();
    expect(leases.claimTableLease).not.toHaveBeenCalled();
  });

  it.each([
    { ...row, arena: { id: ARENA, asset: 'chips', is_platform: false } },
    { ...row, club_id: null, union_id: ARENA, arena: null },
  ])('leaves chip cash independent of the Diamond settings', async (chip) => {
    const from = database(chip, () => {
      throw new Error('unexpected Diamond settings read');
    });
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('ready');
    expect(leases.claimTableLease).toHaveBeenCalledTimes(1);
    expect(engines.created).toHaveLength(1);
    expect(from.mock.calls.filter(([name]) => name === 'ca_arena_settings')).toHaveLength(0);
  });

  it('never routes a tournament through the cash policy or lease', async () => {
    const from = database({ ...row, game_type: 'tournament', tournament_id: 'tournament' }, () => {
      throw new Error('cash admission must not read tournament policy');
    });
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('not_wakeable');
    expect(from).toHaveBeenCalledTimes(1);
    expect(leases.claimTableLease).not.toHaveBeenCalled();
    expect(engines.created).toHaveLength(0);
  });

  it('holds a raced refusal through physical stop and original-generation release, without readmission', async () => {
    let reads = 0;
    database(row, () => ({
      data: { club_id: ARENA, cash_games_enabled: reads++ === 0 },
      error: null,
    }));
    const stop = deferred<void>();
    const release = deferred<any>();
    engines.stop.mockImplementation(async (engine: any) => {
      await stop.promise;
      engine.released = true;
    });
    vi.mocked(leases.releaseTables).mockReturnValue(release.promise);
    const server = bareServer();
    const concurrent = [
      server.ensureCashTableEngineAdmission(TABLE),
      server.ensureCashTableEngineAdmission(TABLE),
    ];
    await settleMicrotasks();
    const engine = engines.created[0];
    let admissionSettled = false;
    void concurrent[0].then(() => {
      admissionSettled = true;
    });
    await expect(engine.ready).resolves.toBe(false);
    // A third caller during physical teardown joins the same admission.
    concurrent.push(server.ensureCashTableEngineAdmission(TABLE));
    await settleMicrotasks();
    expect(admissionSettled).toBe(false);
    expect(engines.created).toHaveLength(1);
    expect(engines.stop).toHaveBeenCalledTimes(1);
    expect(server.tableEngines.get(TABLE)).toBe(engine);
    expect(server.directTableEngineRecoveryJobs.size).toBe(1);
    expect(leases.releaseTables).not.toHaveBeenCalled();
    expect(server.directTableRecoveryTimers.size).toBe(0);
    expect(server.engineStartFailures).toBe(0);

    stop.resolve();
    await settleMicrotasks();
    expect(leases.releaseTables).toHaveBeenCalledWith([
      { tableId: TABLE, leaseGeneration: GENERATION },
    ]);
    expect(server.tableEngines.get(TABLE)).toBe(engine);
    expect(server.directTableEngineRecoveryJobs.size).toBe(1);
    expect(admissionSettled).toBe(false);
    release.resolve({ status: 'confirmed', attempts: 1, released: 1 });
    await expect(Promise.all(concurrent)).resolves.toEqual([
      'policy_closed',
      'policy_closed',
      'policy_closed',
    ]);
    expect(server.tableEngines.has(TABLE)).toBe(false);
    expect(leases.claimTableLease).toHaveBeenCalledTimes(1);
    expect(server.directTableRecoveryTimers.size).toBe(0);
    expect(errors.reportError).not.toHaveBeenCalled();
  });

  it('preserves a raced policy cleanup failure and its still-owned lease', async () => {
    let reads = 0;
    database(row, () => ({
      data: { club_id: ARENA, cash_games_enabled: reads++ === 0 },
      error: null,
    }));
    const failure = new Error('physical startup work remains pending');
    engines.stop.mockRejectedValue(failure);
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('retryable_failure');
    server.finishDirectTableAdmission(TABLE, 'test', 'retryable_failure');
    await settleMicrotasks();
    expect(server.tableEngines.get(TABLE)).toBe(engines.created[0]);
    expect(leases.releaseTables).not.toHaveBeenCalled();
    expect(errors.reportError).toHaveBeenCalledWith(
      failure,
      'GameServer.direct_table_engine_recovery_teardown_failed',
      expect.objectContaining({ tableId: TABLE })
    );
    expect(server.directTableRecoveryTimers.size).toBe(1);
    expect(leases.claimTableLease).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed exact-generation release visible and retryable without constructing another engine', async () => {
    let reads = 0;
    database(row, () => ({
      data: { club_id: ARENA, cash_games_enabled: reads++ === 0 },
      error: null,
    }));
    vi.mocked(leases.releaseTables).mockResolvedValue({
      status: 'unconfirmed',
      reason: 'transport_unknown',
      attempts: 1,
      detail: 'response lost',
    } as any);
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('retryable_failure');
    server.finishDirectTableAdmission(TABLE, 'test', 'retryable_failure');
    await settleMicrotasks();
    expect(server.tableEngines.get(TABLE)).toBe(engines.created[0]);
    expect(errors.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.direct_table_start_recovery_threw',
      { tableId: TABLE }
    );
    expect(server.directTableRecoveryTimers.size).toBe(1);
    expect(leases.claimTableLease).toHaveBeenCalledTimes(1);
  });

  it('cannot delete or release a replacement that wins during old-object stop', async () => {
    const server = bareServer();
    const stop = deferred<void>();
    const old = {
      stop: () => stop.promise,
      hasReleasedProcessOwnership: () => false,
      getEngineLeaseAuthority: () => ({ scope: 'cash', verified: true, generation: GENERATION }),
      getStartupPolicyRefusal: () => ({ code: 'diamond_cash_disabled' }),
    };
    const replacement = {};
    server.tableEngines.set(TABLE, old);
    const retiring = server.recoverDirectTableEngine(TABLE, old, 'policy_closed', true);
    server.tableEngines.set(TABLE, replacement);
    stop.resolve();
    await retiring;
    expect(server.tableEngines.get(TABLE)).toBe(replacement);
    expect(leases.releaseTables).not.toHaveBeenCalled();
  });

  it('does not cache the refusal when a later authorized settings read opens the arena', async () => {
    let enabled = false;
    database(row, () => ({ data: { club_id: ARENA, cash_games_enabled: enabled }, error: null }));
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('policy_closed');
    expect(leases.claimTableLease).not.toHaveBeenCalled();
    enabled = true;
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('ready');
    expect(leases.claimTableLease).toHaveBeenCalledTimes(1);
    expect(engines.created).toHaveLength(1);
  });

  it('still counts and retries an ordinary startup failure', async () => {
    database(row, () => ({ data: { club_id: ARENA, cash_games_enabled: true }, error: null }));
    const failure = new Error('ordinary startup failure');
    engines.start.mockImplementation(async (engine: any) => {
      engine.resolveReady(false);
      throw failure;
    });
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('retryable_failure');
    await settleMicrotasks();
    expect(server.engineStartFailures).toBe(1);
    expect(errors.reportError).toHaveBeenCalledWith(
      failure,
      'GameServer.direct_table_start_failed'
    );
    expect(server.directTableRecoveryTimers.size).toBe(1);
  });
});
