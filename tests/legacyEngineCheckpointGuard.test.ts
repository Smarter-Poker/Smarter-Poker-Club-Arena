import { describe, expect, it } from 'vitest';
import { legacyEngineCheckpointGuard } from '../server/scripts/legacy-engine-checkpoint-guard.mjs';
import * as dataActorContext from '../server/src/services/supabase/dataActorContext';

const release = '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5';
const checkpoint758 = '758610f3f844406bbbaee2f5100ced36d84fb943';
const checkpointA0 = 'a0ab287d902879280f0c915e44f5222c5db4d7df';
const instance = '1-c86a8f37';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pins = [
  'bfcb47c498c34408dd95047e90535c7ddc1ecc5fef14e41e1063ec72a1aad119',
  'f5c8f4f814d7fd5649cea03698443c21c592e7db1ac6c1ac9fc756af5a72c407',
  'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
];
const pins758 = [
  'f8a4e646348fbd0209b9afde24658660dca0837f7720e04b47d37cff4fa2bea7',
  'cc715650eca1b6cfbccadcef46a9f07f581549e75df6581cb8c32f3fbfffc0b3',
  'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
  '44a7c52ede31dd3a5600d6b648b0d34c9ecabc3e10f14a65830712b432dc62e9',
];
const pinsA0 = [
  ...pins758.slice(0, 3),
  'a15d068c8a43ab0c34a208abf4380815813cf71a703978e334ed5c78ef70788b',
];

function fixture(count = 1, predecessor = release) {
  const rows = new Map();
  const calls: string[] = [];
  let remaining = 300000;
  let onWrite: ((engine: Table) => Promise<void> | void) | undefined;
  let onRead: ((data: any[]) => any[]) | undefined;
  class Maintenance {
    phase = 'counting_down';
    announcedAt = Date.now() - 120000;
    breakStartedAt = this.announcedAt + 120000;
    breakEndsAt = this.breakStartedAt + 300000;
    reason = 'Scheduled Engine Maintenance';
    ownershipToken = uuid(9000);
    lifecycleGeneration = 1;
    resumeToken = 1;
    durableConfirmed = true;
    ending = false;
    acceptingLifecycleWork = true;
    releaseBoundaryOnly = false;
    recoveryReadPending = false;
    stopOperation = null;
    lastDurableState = {
      phase: this.phase,
      announcedAt: this.announcedAt,
      breakStartedAt: this.breakStartedAt,
      breakEndsAt: this.breakEndsAt,
      reason: this.reason,
      ownershipToken: this.ownershipToken,
    };
    remainingMs() {
      return remaining;
    }
    readyForRestart() {
      return [...server.tableEngines.values()].every((e) => e.isMaintenanceStateDurable());
    }
  }
  class Table {
    tableId: string;
    running = true;
    terminal = false;
    teardownPromise = null;
    maintenancePaused = true;
    holdBeforeNextHand = true;
    handForHandResolve = () => undefined;
    pauseGateTimer = null;
    handController: object | null = null;
    settlementInFlight = new Set();
    postHandTasksPromise: Promise<void> | null = null;
    actionLock = false;
    tournamentMoveOperations = new Set();
    terminalBoundaryPendingGenerations = new Set();
    terminalBoundaryPersistenceFailed = false;
    handCount = 17;
    seatedPlayers: any[];
    timeBankMeta = new Map();
    timeBankEngine = { playerBanks: new Map() };
    parkedTimeBanks = {};
    parkedBankSaveComplete = false;
    presenceSave = Promise.resolve();
    maintenanceCheckpointGeneration = 1;
    timeBankAccountingPending = new Set<Promise<void>>();
    timeBankAccountingUnconfirmed = false;
    f06CurrentPermit: object | null = null;
    f06RecoveryInFlight = false;
    disconnectEngine = { getFsmStatesForTable: () => ({}) };
    constructor(n: number) {
      this.tableId = uuid(n);
      const userId = uuid(n + 10000);
      this.seatedPlayers = [
        { user_id: userId, occupancy_id: uuid(n + 20000), seat_number: 1, stack: 100 },
      ];
      this.timeBankMeta.set(userId, { initialSeconds: 90, baseSeconds: 30, dbConsumedSeconds: 15 });
      this.timeBankEngine.playerBanks.set(`${this.tableId}:${userId}`, {
        tableId: this.tableId,
        playerId: userId,
        remainingSeconds: 75,
        usesRemaining: 2,
        isActive: false,
      });
    }
    captureParkedTimeBanks() {
      const saved: any = { ...this.parkedTimeBanks };
      for (const seat of this.seatedPlayers) {
        const bank = this.timeBankEngine.playerBanks.get(`${this.tableId}:${seat.user_id}`);
        const meta = this.timeBankMeta.get(seat.user_id);
        if (!bank || !meta || bank.isActive || !seat.occupancy_id) continue;
        saved[seat.user_id] = {
          occupancyId: seat.occupancy_id,
          remainingSeconds: bank.remainingSeconds,
          usesRemaining: bank.usesRemaining,
          ...meta,
        };
      }
      return saved;
    }
    isMaintenanceStateDurable() {
      return this.timeBankEngine.playerBanks.size === 0 || this.parkedBankSaveComplete;
    }
    hasReleasedProcessOwnership() {
      return !this.running && this.terminal;
    }
    async persistPresenceForRestart(when: string) {
      const previous = this.presenceSave;
      let finish!: () => void;
      this.presenceSave = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await previous;
      try {
        calls.push(when);
        await onWrite?.(this);
        const parkedAt = new Date().toISOString();
        rows.set(this.tableId, {
          table_id: this.tableId,
          engine_instance: `${instance}:parked`,
          parked_at: parkedAt,
          disconnect_states: this.disconnectEngine.getFsmStatesForTable(),
          time_bank_snapshot: {
            version: 1,
            parkedAt,
            handNumber: this.handCount,
            players: this.captureParkedTimeBanks(),
          },
        });
        this.parkedBankSaveComplete = true;
      } finally {
        finish();
      }
    }
  }
  class Server {
    running = true;
    teardownPromise = null;
    lifecycleGeneration = 1;
    maintenanceBreak = new Maintenance();
    tableEngines = new Map(
      Array.from({ length: count }, (_, i) => {
        const table = new Table(i + 1);
        return [table.tableId, table];
      })
    );
  }
  const server = new Server();
  const modules = {
    dataActorContext,
    gameServer: { GameServer: Server },
    base: { ServerTableEngineBase: Table },
    maintenance: { MaintenanceBreak: Maintenance },
    freezeState: { isMaintenanceFrozen: () => true },
    releaseIdentity: {
      ENGINE_RELEASE_IDENTITY: { releaseSha: predecessor, version: predecessor.slice(0, 8) },
    },
    tableLease: { INSTANCE_ID: instance },
    fs: {
      statSync: () => ({ isFile: () => true, size: 1 }),
      readFileSync: (path: string) => {
        return Buffer.from([
          path.endsWith('/GameServer.js')
            ? 0
            : path.endsWith('/ServerTableEngineBase.js')
              ? 1
              : path.endsWith('/ServerTableEngineDealing.js')
                ? 3
                : 2,
        ]);
      },
    },
    crypto: {
      createHash: () => ({
        update: (bytes: Buffer) => ({
          digest: () =>
            (predecessor === checkpointA0
              ? pinsA0
              : predecessor === checkpoint758
                ? pins758
                : pins)[bytes[0]],
        }),
      }),
    },
    client: {
      supabase: {
        from: (name: string) => {
          expect(name).toBe('engine_presence_parked');
          return {
            select: () => ({
              in: (_key: string, ids: string[]) => ({
                limit: async (bound: number) => {
                  expect(bound).toBe(ids.length + 1);
                  const data = structuredClone(ids.map((id) => rows.get(id)).filter(Boolean));
                  return { data: onRead ? onRead(data) : data, error: null };
                },
              }),
            }),
          };
        },
      },
    },
  };
  const options = {
    expectedReleaseSha: predecessor,
    expectedInstanceId: instance,
    expectedPid: process.pid,
  };
  return {
    server,
    modules,
    options,
    calls,
    rows,
    first: [...server.tableEngines.values()][0],
    run: (discovered = [server]) =>
      legacyEngineCheckpointGuard.call(server, options, discovered, modules),
    onWrite: (hook: typeof onWrite) => {
      onWrite = hook;
    },
    onRead: (hook: typeof onRead) => {
      onRead = hook;
    },
    remaining: (value: number) => {
      remaining = value;
    },
  };
}

describe('legacy checkpoint admission and exact persisted readback', () => {
  it('checkpoints the exact a0 original owner with its measured compiled bytes', async () => {
    const f = fixture(1, checkpointA0);
    expect(await f.run()).toMatchObject({
      ok: true,
      attemptedTables: 1,
      verifiedTables: 1,
      paidAccountingQualification: 'native_pending_registry_drained',
      restartAuthorized: false,
    });
    expect(f.calls).toEqual(['parked']);
  });

  it.each([
    'pending-accounting',
    'unconfirmed-accounting',
    'retained-permit',
    'recovery-in-flight',
    '758-dealing-bytes',
  ])('refuses exact a0 %s before any native write', async (cause) => {
    const f = fixture(1, checkpointA0);
    if (cause === 'pending-accounting') f.first.timeBankAccountingPending.add(Promise.resolve());
    if (cause === 'unconfirmed-accounting') f.first.timeBankAccountingUnconfirmed = true;
    if (cause === 'retained-permit') f.first.f06CurrentPermit = {};
    if (cause === 'recovery-in-flight') f.first.f06RecoveryInFlight = true;
    if (cause === '758-dealing-bytes')
      f.modules.crypto.createHash = () => ({
        update: (bytes: Buffer) => ({ digest: () => pins758[bytes[0]] }),
      });
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    expect(f.calls).toEqual([]);
  });

  it('retains the a0 original checkpoint generation through the announcement join', async () => {
    const f = fixture(1, checkpointA0);
    f.first.presenceSave = Promise.resolve().then(() => {
      f.first.maintenanceCheckpointGeneration++;
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'native_checkpoint_owner_changed',
      attemptedTables: 0,
    });
    expect(f.calls).toEqual([]);
  });
  it('checkpoints the exact758 original owner with tracked accounting already drained', async () => {
    const f = fixture(1, checkpoint758);
    expect(await f.run()).toMatchObject({
      ok: true,
      attemptedTables: 1,
      verifiedTables: 1,
      paidAccountingQualification: 'native_pending_registry_drained',
      restartAuthorized: false,
    });
    expect(f.calls).toEqual(['parked']);
  });

  it.each([
    'missing-accounting',
    'pending-accounting',
    'unconfirmed-accounting',
    'retained-permit',
    'recovery-in-flight',
    'mixed-pins',
  ])('refuses758 %s before any original write', async (cause) => {
    const f = fixture(1, checkpoint758);
    if (cause === 'missing-accounting')
      Object.assign(f.first, { timeBankAccountingPending: undefined });
    if (cause === 'pending-accounting') f.first.timeBankAccountingPending.add(Promise.resolve());
    if (cause === 'unconfirmed-accounting') f.first.timeBankAccountingUnconfirmed = true;
    if (cause === 'retained-permit') f.first.f06CurrentPermit = {};
    if (cause === 'recovery-in-flight') f.first.f06RecoveryInFlight = true;
    if (cause === 'mixed-pins')
      f.modules.crypto.createHash = () => ({
        update: (bytes: Buffer) => ({ digest: () => pins[bytes[0]] }),
      });
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    expect(f.calls).toEqual([]);
  });

  it.each(['accounting-registry', 'checkpoint-generation'])(
    'refuses758 changed %s after joining original announcement and before writing',
    async (cause) => {
      const f = fixture(1, checkpoint758);
      f.first.presenceSave = Promise.resolve().then(() => {
        if (cause === 'accounting-registry') f.first.timeBankAccountingPending = new Set();
        else f.first.maintenanceCheckpointGeneration++;
      });
      expect(await f.run()).toMatchObject({
        ok: false,
        attemptedTables: 0,
        restartAuthorized: false,
      });
      expect(f.calls).toEqual([]);
    }
  );

  const stopEmpty = (f: ReturnType<typeof fixture>) => {
    Object.assign(f.first, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
      maintenancePaused: false,
      holdBeforeNextHand: false,
      handForHandResolve: null,
    });
    f.first.timeBankMeta.clear();
    f.first.timeBankEngine.playerBanks.clear();
    f.first.seatedPlayers = [];
  };

  it('does not drop retained758 F06 custody from an otherwise empty stopped engine', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06CurrentPermit = {};
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      reason: 'f06_custody_not_drained',
      paidAccountingQualification: 'native_pending_registry_unqualified',
    });
    expect(f.calls).toEqual([]);
  });

  it('does not accept758 readback from an announcement even after the native ready bit changes', async () => {
    const f = fixture(1, checkpoint758);
    f.onRead((rows) => {
      rows[0].time_bank_snapshot = null;
      return rows;
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'checkpoint_readback_mismatch' });
    expect(f.calls).toEqual(['parked']);
  });

  it('joins an empty stopped owner and checkpoints the active owner only', async () => {
    const f = fixture(2);
    stopEmpty(f);
    expect(await f.run()).toMatchObject({ ok: true, attemptedTables: 1, verifiedTables: 1 });
    expect(f.calls).toEqual(['parked']);
  });

  it('refuses a failed teardown before starting any active checkpoint', async () => {
    const f = fixture(2);
    stopEmpty(f);
    Object.assign(f.first, { teardownPromise: Promise.reject(new Error('teardown failed')) });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'previous_native_work_unconfirmed' });
    expect(f.calls).toEqual([]);
  });

  it('does not drop bank custody from a stopped engine', async () => {
    const f = fixture(2);
    Object.assign(f.first, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'stopped_engine_retains_custody' });
    expect(f.calls).toEqual([]);
  });

  const bindTournament = (f: ReturnType<typeof fixture>) => {
    const authority = { tournamentId: uuid(70001), leaseGeneration: uuid(70002) };
    Object.assign(f.first, {
      engineLeaseScope: 'tournament',
      engineLeaseVerified: true,
      engineLeaseTournamentId: authority.tournamentId,
      engineLeaseGeneration: authority.leaseGeneration,
    });
    dataActorContext.bindTournamentDataAuthorityMethods(authority, f.first);
    return authority;
  };

  it('preserves the real tournament authority wrappers while saving and reading back', async () => {
    const f = fixture();
    const authority = bindTournament(f);
    const original = f.first.persistPresenceForRestart;
    f.onWrite(() => {
      expect(dataActorContext.currentTournamentDataAuthority()).toMatchObject(authority);
    });
    expect(await f.run()).toMatchObject({ ok: true, verifiedTables: 1 });
    expect(f.first.persistPresenceForRestart).toBe(original);
    expect(dataActorContext.currentTournamentDataAuthority()).toBeNull();
  });

  it('refuses a different tournament generation before saving', async () => {
    const f = fixture();
    bindTournament(f);
    Object.assign(f.first, { engineLeaseGeneration: uuid(77777) });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_authority_invalid' });
    expect(f.calls).toEqual([]);
  });

  it('refuses a replaced tournament method before saving', async () => {
    const f = fixture();
    bindTournament(f);
    f.first.persistPresenceForRestart = async () => undefined;
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_method_mismatch' });
    expect(f.calls).toEqual([]);
  });

  it('refuses to inherit another tournament authority into the fleet operation', async () => {
    const f = fixture();
    const authority = bindTournament(f);
    const result = await dataActorContext.runWithTournamentDataAuthority(authority, () => f.run());
    expect(result).toMatchObject({ ok: false, reason: 'unexpected_tournament_context' });
    expect(f.calls).toEqual([]);
  });

  it('refuses replacement by another valid bound wrapper during the write', async () => {
    const f = fixture();
    const authority = bindTournament(f);
    const native = Object.getPrototypeOf(f.first).persistPresenceForRestart;
    f.onWrite(() => {
      f.first.persistPresenceForRestart = dataActorContext.bindTournamentDataAuthority(
        authority,
        native
      );
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_method_changed' });
    expect(f.calls).toHaveLength(1);
  });

  it('joins the native announcement before a parked write and verifies every saved field', async () => {
    const f = fixture();
    f.first.presenceSave = Promise.resolve().then(() => {
      f.rows.set(f.first.tableId, { time_bank_snapshot: null });
    });
    const result = await f.run();
    expect(result).toMatchObject({
      ok: true,
      attemptedTables: 1,
      completedCalls: 1,
      verifiedTables: 1,
      bankCount: 1,
      restartAuthorized: false,
      paidAccountingQualification: 'legacy_untracked',
    });
    expect(f.calls).toEqual(['parked']);
    expect(f.rows.get(f.first.tableId).time_bank_snapshot.players[uuid(10001)]).toEqual({
      occupancyId: uuid(20001),
      remainingSeconds: 75,
      usesRemaining: 2,
      initialSeconds: 90,
      baseSeconds: 30,
      dbConsumedSeconds: 15,
    });
  });

  it.each([
    [
      'active hand',
      (f: ReturnType<typeof fixture>) => {
        f.first.handController = {};
      },
    ],
    [
      'settlement',
      (f: ReturnType<typeof fixture>) => {
        f.first.settlementInFlight.add(Promise.resolve());
      },
    ],
    [
      'unheld pause',
      (f: ReturnType<typeof fixture>) => {
        f.first.handForHandResolve = null as any;
      },
    ],
    [
      'active bank',
      (f: ReturnType<typeof fixture>) => {
        [...f.first.timeBankEngine.playerBanks.values()][0].isActive = true;
      },
    ],
    [
      'missing metadata',
      (f: ReturnType<typeof fixture>) => {
        f.first.timeBankMeta.clear();
      },
    ],
    [
      'invalid occupancy',
      (f: ReturnType<typeof fixture>) => {
        f.first.seatedPlayers[0].occupancy_id = null;
      },
    ],
    [
      'insufficient reserve',
      (f: ReturnType<typeof fixture>) => {
        f.remaining(284999);
      },
    ],
    [
      'wrong source',
      (f: ReturnType<typeof fixture>) => {
        f.options.expectedReleaseSha = 'f'.repeat(40);
      },
    ],
    [
      'unconfirmed freeze',
      (f: ReturnType<typeof fixture>) => {
        f.server.maintenanceBreak.durableConfirmed = false;
      },
    ],
    [
      'changed compiled bytes',
      (f: ReturnType<typeof fixture>) => {
        f.modules.fs.readFileSync = () => Buffer.from([9]);
      },
    ],
  ])('refuses %s before invoking a native write', async (_label, change) => {
    const f = fixture();
    change(f);
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    expect(f.calls).toEqual([]);
  });

  it('refuses zero or ambiguous server discovery', async () => {
    for (const count of [0, 2]) {
      const f = fixture();
      expect(await f.run(Array(count).fill(f.server))).toMatchObject({
        ok: false,
        reason: 'server_not_unique',
      });
      expect(f.calls).toEqual([]);
    }
  });

  it.each([
    [
      'announcement overwrite',
      (data: any[]) => {
        data[0].time_bank_snapshot = null;
        return data;
      },
    ],
    ['incomplete readback', () => []],
    [
      'wrong occupancy',
      (data: any[]) => {
        data[0].time_bank_snapshot.players[uuid(10001)].occupancyId = uuid(999);
        return data;
      },
    ],
    [
      'wrong bank amount',
      (data: any[]) => {
        data[0].time_bank_snapshot.players[uuid(10001)].remainingSeconds++;
        return data;
      },
    ],
    [
      'wrong instance',
      (data: any[]) => {
        data[0].engine_instance = '1-deadbeef:parked';
        return data;
      },
    ],
  ])('refuses %s even when the native ready bit is true', async (_label, mutate) => {
    const f = fixture();
    f.onRead(mutate);
    const result = await f.run();
    expect(f.first.parkedBankSaveComplete).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      checkpointOutcome: 'unconfirmed',
      restartAuthorized: false,
    });
    expect(f.calls).toHaveLength(1);
  });

  it('refuses a changed presence writer without assigning readiness or retrying', async () => {
    const f = fixture();
    f.onWrite((engine) => {
      engine.presenceSave = Promise.resolve();
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'presence_writer_changed' });
    expect(f.calls).toEqual(['parked']);
  });

  it('stops new work when time is exhausted and joins already started writes', async () => {
    const f = fixture(40);
    let finished = 0;
    f.onWrite(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      finished++;
      f.remaining(284999);
    });
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_reserve' });
    expect(f.calls.length).toBe(32);
    expect(finished).toBe(32);
    expect(result.completedCalls).toBe(32);
  });

  it('does not invent a bank for a player who has never been dealt in', async () => {
    const f = fixture();
    f.first.timeBankMeta.clear();
    f.first.timeBankEngine.playerBanks.clear();
    expect(await f.run()).toMatchObject({
      ok: true,
      attemptedTables: 0,
      bankCount: 0,
      uninitializedSeats: 1,
    });
    expect(f.calls).toEqual([]);
  });
});
