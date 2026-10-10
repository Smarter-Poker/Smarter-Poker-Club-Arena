/**
 * A STANDING RETAINED-HAND REFUSAL HOLDS THE TABLE; IT DOES NOT REBUILD IT
 * EVERY FIVE SECONDS (2026-09-29)
 *
 * Production, 02:10-02:25 UTC: cash tables 499aa67a and 6c9ee4b6 were rebuilt
 * 223 times in fifteen minutes. Each start asked fn_ca_resume_hand_submission
 * for the table's retained hand, the door refused from durable rows
 * (HAND_SUBMISSION_TABLE_NOT_ADMITTED, HAND_SUBMISSION_HANDOFF_STATE_CHANGED),
 * start() turned that into `watchdog_kill: start_failed:start_load_table`, a
 * recovery row and an immediate rebuild into the same answer, and discovery
 * spent a start-budget slot on it every sweep.
 *
 * Pinned here, against the real modules:
 *   1. resumeRetainedHandSubmission names a standing refusal
 *      (RetainedHandSubmissionRefusedError) and leaves every transient one a
 *      plain error, with the log text unchanged.
 *   2. start() fences a cash generation on that refusal without a watchdog
 *      kill or recovery row, and publishes it before ready=false.
 *   3. GameServer holds the table: exact lease release, no retry timer, one
 *      report; further admissions and discovery do not read, claim or build
 *      until the recheck is due; an unchanged answer on recheck is silent; a
 *      changed code is said again; a start releases the hold.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadTable = vi.fn();
const loadSeatedPlayers = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { GameServer } = await import('../GameServer.js');
const { supabase } = await import('../services/supabase/client.js');
const leases = await import('../services/tableLease.js');
const errors = await import('../services/errorReporter.js');
const {
  RETAINED_HAND_STANDING_REFUSALS,
  RetainedHandSubmissionRefusedError,
  resumeRetainedHandSubmission,
} = await import('../services/supabase/handHistory.js');

const TABLE = '499aa67a-986d-45db-bbfe-b08dd448843e';
const OTHER = '6c9ee4b6-609c-48ff-b027-685ab8499937';
const GENERATION = '4a7464bc-f5ec-4a52-9865-c8142cc842d0';
const cashAuthority = () => ({
  scope: 'cash' as const,
  verified: true,
  generation: GENERATION,
  proofDeadlineMonotonicMs: performance.now() + 60_000,
});

afterEach(() => {
  vi.restoreAllMocks();
  loadTable.mockReset();
  loadSeatedPlayers.mockReset();
});

describe('the door names a standing refusal and nothing else', () => {
  it.each([...RETAINED_HAND_STANDING_REFUSALS])('%s is a standing refusal', async (code) => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: { message: code } } as any);
    const error = await resumeRetainedHandSubmission(TABLE, 'i', GENERATION).catch((e) => e);
    expect(error).toBeInstanceOf(RetainedHandSubmissionRefusedError);
    expect(error).toMatchObject({ tableId: TABLE, code });
    expect(error.message).toBe(`retained_hand_submission_readback_failed: ${code}`);
  });

  it.each([
    'HAND_SUBMISSION_PLATFORM_FROZEN',
    'HAND_SUBMISSION_MAINTENANCE_BUSY',
    'HAND_SUBMISSION_LEASE_UNPROVEN',
    'HAND_SUBMISSION_SCOPE_CHANGED',
    'F06_HAND_DISPATCH_BUSY',
    'canceling statement due to lock timeout',
    'HAND_SUBMISSION_ADMISSION_CHANGED: {"success": false}',
  ])('%s stays an ordinary, retried failure', async (message) => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: { message } } as any);
    const error = await resumeRetainedHandSubmission(TABLE, 'i', GENERATION).catch((e) => e);
    expect(error).not.toBeInstanceOf(RetainedHandSubmissionRefusedError);
    expect(error.message).toBe(`retained_hand_submission_readback_failed: ${message}`);
  });

  it('the set is exactly the refusals answered from durable rows', () => {
    expect([...RETAINED_HAND_STANDING_REFUSALS].sort()).toEqual([
      'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN',
      'HAND_SUBMISSION_HANDOFF_STATE_CHANGED',
      'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED',
      'HAND_SUBMISSION_TABLE_MISSING',
      'HAND_SUBMISSION_TABLE_NOT_ADMITTED',
    ]);
  });
});

function startable(authority: any, refusal: unknown) {
  const engine = new ServerTableEngine(TABLE, authority) as any;
  const killed: string[] = [];
  const realKill = engine.killForRestart.bind(engine);
  engine.killForRestart = (reason: string, notify?: boolean) => {
    killed.push(reason);
    realKill(reason, notify);
  };
  engine.sleep = async () => {};
  engine.seedHandCountFromHistory = async () => {};
  engine.restoreButtonFromHistory = async () => {};
  engine.restoreSitOutsFromSeats = () => {};
  engine.evictExpiredSitOuts = async () => {};
  engine.checkCrashRecovery = async () => {
    throw refusal;
  };
  engine.readParkedTimeBanks = async () => {};
  engine.resolveOrphanedAddOns = async () => {};
  engine.broadcastCurrentState = async () => {};
  engine.scheduleHeartbeatCheck = () => {};
  engine.dealingLoop = async () => {};
  engine.recordRecoveryEvent = vi.fn();
  return { engine, killed };
}

describe('start() fences a standing refusal instead of killing for restart', () => {
  beforeEach(() => {
    vi.spyOn(supabase, 'rpc').mockImplementation((name: string) => {
      if (name === 'fn_ca_get_table_operator_hold')
        return Promise.resolve({
          data: { paused: false, version: 0, command_id: null },
          error: null,
        }) as any;
      throw new Error(`Unexpected native RPC: ${name}`);
    });
    vi.spyOn(errors, 'reportError').mockImplementation(() => {});
    loadTable.mockResolvedValue({ id: TABLE, small_blind: 1, big_blind: 2, ante: 0 });
    loadSeatedPlayers.mockResolvedValue([]);
  });

  it('publishes the refusal before ready=false, with no watchdog kill and no recovery row', async () => {
    const refusal = new RetainedHandSubmissionRefusedError(
      TABLE,
      'HAND_SUBMISSION_TABLE_NOT_ADMITTED'
    );
    const { engine, killed } = startable(cashAuthority(), refusal);
    const seen = engine.ready.then((value: boolean) => ({
      value,
      refusal: engine.getStartupRetainedHandRefusal(),
    }));
    await expect(engine.start()).rejects.toBe(refusal);
    const observed = await seen;
    expect(observed.value).toBe(false);
    expect(observed.refusal).toEqual({
      code: 'HAND_SUBMISSION_TABLE_NOT_ADMITTED',
      tableId: TABLE,
    });
    expect(Object.isFrozen(observed.refusal)).toBe(true);
    expect(killed).toEqual([]);
    expect(engine.recordRecoveryEvent).not.toHaveBeenCalled();
    expect(errors.reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      `ServerTableEngine.${TABLE}.failed_to_start`
    );
    expect(engine.running).toBe(false);
    await engine.stop();
  });

  it("another table's refusal, or an ordinary error, is still a start_failed kill", async () => {
    for (const error of [
      new RetainedHandSubmissionRefusedError(OTHER, 'HAND_SUBMISSION_TABLE_NOT_ADMITTED'),
      new Error('retained_hand_submission_readback_failed: HAND_SUBMISSION_LEASE_UNPROVEN'),
    ]) {
      const { engine, killed } = startable(cashAuthority(), error);
      await expect(engine.start()).rejects.toBe(error);
      expect(engine.getStartupRetainedHandRefusal()).toBeNull();
      expect(killed).toEqual(['start_failed:start_load_table']);
      await engine.stop();
    }
  });
});

describe('GameServer holds a refused cash table and says so once', () => {
  const row = {
    id: TABLE,
    tournament_id: null,
    status: 'waiting',
    game_type: 'cash',
    is_deleted: false,
    // A union-owned chip table: no Diamond policy read on this path.
    club_id: null,
    union_id: '002c2d27-9584-4e52-835a-bb2be148fc81',
    arena: null,
  };
  let starts: Array<(engine: any) => Promise<void>>;
  let created: any[];

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
    return server;
  }

  const refuse = (code: string) => async (engine: any) => {
    const error = new RetainedHandSubmissionRefusedError(TABLE, code);
    engine.startupRetainedHandRefusal = Object.freeze({ code, tableId: TABLE });
    engine.fenceTerminalEngine('startup_retained_hand_refused', false);
    throw error;
  };
  const succeed = async (engine: any) => {
    engine.running = true;
    engine.settleReady(true);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    starts = [];
    created = [];
    vi.spyOn(errors, 'reportError').mockImplementation(() => {});
    vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
      if (relation !== 'tables') throw new Error('Unexpected database read: ' + relation);
      const chain: any = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(async () => ({ data: row, error: null })),
      };
      chain.select.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      return chain;
    }) as any);
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
    vi.spyOn(ServerTableEngine.prototype, 'start').mockImplementation(async function (this: any) {
      created.push(this);
      const next = starts.shift();
      if (!next) throw new Error('no scripted start');
      await next(this);
    });
    vi.spyOn(ServerTableEngine.prototype, 'stop').mockResolvedValue(undefined);
    vi.spyOn(ServerTableEngine.prototype, 'hasReleasedProcessOwnership').mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const reports = () =>
    vi
      .mocked(errors.reportError)
      .mock.calls.filter(([, where]) => where === 'GameServer.retained_hand_refusal_holds_table');

  it('releases the exact lease, arms no retry, counts no start failure and reports once', async () => {
    starts.push(refuse('HAND_SUBMISSION_TABLE_NOT_ADMITTED'));
    const server = bareServer();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe(
      'retained_hand_refused'
    );
    server.finishDirectTableAdmission(TABLE, 'test', 'retained_hand_refused');
    for (let n = 0; n < 40; n++) await Promise.resolve();
    expect(leases.releaseTables).toHaveBeenCalledWith([
      { tableId: TABLE, leaseGeneration: GENERATION },
    ]);
    expect(server.tableEngines.has(TABLE)).toBe(false);
    expect(server.directTableRecoveryTimers.size).toBe(0);
    expect(server.engineStartFailures).toBe(0);
    expect(reports()).toHaveLength(1);
    expect(reports()[0][2]).toMatchObject({
      tableId: TABLE,
      code: 'HAND_SUBMISSION_TABLE_NOT_ADMITTED',
    });
    expect(
      vi
        .mocked(errors.reportError)
        .mock.calls.some(([, w]) => w === 'GameServer.direct_table_start_failed')
    ).toBe(false);

    // Held: no read, no lease, no engine, no report until the recheck is due.
    vi.mocked(supabase.from).mockClear();
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe(
      'retained_hand_refused'
    );
    expect(supabase.from).not.toHaveBeenCalled();
    expect(leases.claimTableLease).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(reports()).toHaveLength(1);
    expect(server.getRetainedHandHolds().get(TABLE)?.code).toBe(
      'HAND_SUBMISSION_TABLE_NOT_ADMITTED'
    );
  });

  it('asks again when the recheck is due: the same answer is silent, a new one is said, a start releases', async () => {
    starts.push(
      refuse('HAND_SUBMISSION_TABLE_NOT_ADMITTED'),
      refuse('HAND_SUBMISSION_TABLE_NOT_ADMITTED'),
      refuse('HAND_SUBMISSION_HANDOFF_STATE_CHANGED'),
      succeed
    );
    const server = bareServer();
    await server.ensureCashTableEngineAdmission(TABLE);
    for (let n = 0; n < 40; n++) await Promise.resolve();
    expect(reports()).toHaveLength(1);

    vi.advanceTimersByTime(10 * 60_000 + 1);
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe(
      'retained_hand_refused'
    );
    for (let n = 0; n < 40; n++) await Promise.resolve();
    expect(created).toHaveLength(2);
    expect(reports()).toHaveLength(1);

    vi.advanceTimersByTime(10 * 60_000 + 1);
    await server.ensureCashTableEngineAdmission(TABLE);
    for (let n = 0; n < 40; n++) await Promise.resolve();
    expect(reports()).toHaveLength(2);
    expect(reports()[1][2]).toMatchObject({
      code: 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED',
      previousCode: 'HAND_SUBMISSION_TABLE_NOT_ADMITTED',
    });

    vi.advanceTimersByTime(10 * 60_000 + 1);
    await expect(server.ensureCashTableEngineAdmission(TABLE)).resolves.toBe('ready');
    expect(server.getRetainedHandHolds().has(TABLE)).toBe(false);
  });

  it('discovery neither starts nor spends a budget slot on a held table', () => {
    const src = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    const skip = src.indexOf('if (this.retainedHandHeld(row.table_id)) continue;');
    const running = src.indexOf('if (this.tableEngines.has(row.table_id)) continue;');
    const spend = src.indexOf('startedThisSweep++;', running);
    expect(skip).toBeGreaterThan(running);
    expect(skip).toBeLessThan(spend);
  });
});
