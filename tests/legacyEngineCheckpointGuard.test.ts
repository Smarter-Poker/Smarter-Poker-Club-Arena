import { describe, expect, it } from 'vitest';
import { legacyEngineCheckpointGuard } from '../server/scripts/legacy-engine-checkpoint-guard.mjs';
import { F06HandPermit } from '../server/src/services/F06HandPermit';
import { TournamentRetirementCustody } from '../server/src/services/TournamentRetirementCustody';
import { unregisterOwnedTournamentTableEngine } from '../server/src/tournament/TournamentManagerOwnership';
import * as dataActorContext from '../server/src/services/supabase/dataActorContext';

const release = '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5';
const checkpoint758 = '758610f3f844406bbbaee2f5100ced36d84fb943';
const checkpointA0 = 'a0ab287d902879280f0c915e44f5222c5db4d7df';
const checkpoint8825 = '8825af51817f379c4261658ca29ecc9d8d81932d';
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

const pins8825 = {
  '/app/dist/GameServer.js': 'd87313450daee6035b9ee4945b9ee382d83d71b2ae39f1326a7059fcaa505332',
  '/app/dist/engine/ServerTableEngineBase.js':
    '182cc4a8f3e181154ff586d0dd62506df5eae89f845169e21e7fa39d5e30088b',
  '/app/dist/engine/ServerTableEngineDealing.js':
    '9aff42c79e62ca520b19ad49f5169b346417dabc82c25734b4e40a14a7fb96d1',
  '/app/dist/tournament/TournamentManager.js':
    'b559245800e9f9f69c15a775df3b94f5afe6db926cec7b604c3bc93751bf2e29',
  '/app/dist/tournament/TournamentManagerBase.js':
    '1460070a5fce172faa90c81698d660876535943264b27f6fa9ce89ef0bf10957',
  '/app/dist/tournament/TournamentManagerOwnership.js':
    '0a99e8862c97716ba4435cb477621840f3e48355a018b6457fb6a7f245380fa0',
  '/app/dist/services/F06HandPermit.js':
    'b42c7b954e1ec804b8819996ffe2dc1f1f8e6a74034b84fb17c154f35d9dc956',
  '/app/dist/maintenance/MaintenanceBreak.js':
    'bc61dfe53e3becd3c7bf5cbe72f08b830cc71f68e37c5f06b462dba5588410a6',
  '/app/dist/maintenance/freezeState.js':
    'f8ad56caef98973d535949e14030334ab49b3edbd18a9f6bc711681a469abee8',
  '/app/dist/services/supabase/client.js':
    'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
  '/app/dist/services/supabase/dataActorContext.js':
    '07ff29c562d000690437b62c46c87a10adb1fc40beb54e82ad863632b7e18985',
  '/app/dist/services/tableLease.js':
    '123fa3e6a1dbaa11263b42bb09359859eb55f6ed687020f0bbb0c523f72033ba',
  '/app/dist/releaseIdentity.js':
    '3386b6a5740b7f6fa936b4e1f0727199b0d661e134dcb20424e602c1d3db8c89',
  '/app/dist/services/TournamentRetirementCustody.js':
    '9545296b55652a6861069f5b5ad8d5388d6b2fb36073b67c6235e9c1b0925e1e',
};

function fixture(count = 1, predecessor = release) {
  const activeInstance = predecessor === checkpoint8825 ? '1-3846b8bb' : instance;
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
      return [...server.tableEngines.values()].every(
        (e) =>
          e.isMaintenanceStateDurable() && (predecessor !== checkpoint8825 || !e.f06CurrentPermit)
      );
    }
  }
  class Table {
    static liveEngines = new Map();
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
        ...(predecessor === checkpoint8825 ? { unlimitedActivations: false } : {}),
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
          ...(predecessor === checkpoint8825
            ? { unlimitedActivations: bank.unlimitedActivations ?? false }
            : {}),
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
          engine_instance: `${activeInstance}:parked`,
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
    tournamentEngines = new Map();
    tournamentOwnedTables = new Set<string>();
    tournamentRetirementCustody = new TournamentRetirementCustody();
    unregisterTournamentTableEngine(id: string, engine: Table) {
      return unregisterOwnedTournamentTableEngine(
        this.tableEngines,
        this.tournamentOwnedTables,
        id,
        engine
      );
    }
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
    tableLease: { INSTANCE_ID: activeInstance },
    fs: {
      statSync: () => ({ isFile: () => true, size: 1 }),
      readFileSync: (path: string) => {
        if (predecessor === checkpoint8825)
          return Buffer.from([Object.keys(pins8825).indexOf(path)]);
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
            (predecessor === checkpoint8825
              ? Object.values(pins8825)
              : predecessor === checkpointA0
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
    expectedInstanceId: activeInstance,
    expectedPid: process.pid,
  };
  return {
    Table,
    Server,
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

// The old-image branch runs the same guard and actual synchronous ownership CAS.
// No inspector, database or production game is attached by these fixtures.
function mixedFixture() {
  const f = fixture(1, checkpoint8825);
  const events = ['5a387a75-754a-416e-8fee-b85b15fc2702', '615783bf-15e3-40b7-9368-75f21b6ac53b'];
  const receipts = new Map();
  const rpcCalls: string[] = [];
  let onRpc: ((name: string, input: any) => void) | undefined;
  let changeResponse: ((name: string, data: any) => any) | undefined;
  class Manager {
    gameServer = f.server;
    tournamentId: string;
    tournamentLeaseGeneration: string;
    tournamentMoveBoundaryOwner: string;
    managerLifecycleDiagnostics: any;
    tableEngines = new Map();
    drainedF06Originals: any[];
    tournamentSeatMoveSerialTail = Promise.resolve();
    tournamentSeatMoveAuthorityRevision = 1;
    pendingTableBreakRetirement = null;
    retainedTournamentBreakSources = new Map();
    activeStoppedOriginalCustody = new Set();
    pendingNoStartContinuations = new Map();
    stoppedOriginalBreaks = new Map();
    tournamentBreakArrivalWakes = new Map();
    tableEngineRecoveryTimers = new Map();
    durableTournamentBreaks = new Map();
    pendingTournamentSeatMoveOutcomes = new Map();
    pendingTournamentParkRequests = new Map();
    pendingTournamentBreakBegins = new Map();
    pendingTournamentBreakAmendments = new Map();
    rejectedTournamentBreakBegins = new Map();
    resolvedTournamentBreakProposals = new Map();
    pendingTournamentBreakCustodyIds = new Map();
    pendingTournamentCleanupKinds = new Map();
    lifecycleJobs = new Set();
    tableEngineStartJobs = new Set();
    tableEngineRunJobs = new Set();
    eliminationSchedulerJobs = new Set();
    lifecycleTimeouts = new Set();
    lifecycleIntervals = new Set();
    constructor(event: string, n: number, engine: any) {
      this.tournamentId = event;
      this.tournamentLeaseGeneration = uuid(80000 + n);
      this.tournamentMoveBoundaryOwner = uuid(81000 + n);
      this.managerLifecycleDiagnostics = { instanceId: uuid(82000 + n) };
      this.tableEngines.set(engine.tableId, engine);
      this.drainedF06Originals = [[engine.tableId, engine]];
      this.retainedTournamentBreakSources.set(engine.tableId, { breakId: uuid(83000 + n), engine });
      this.pendingTournamentSeatMoveOutcomes.set(uuid(84000 + n), {
        input: { requestId: uuid(84000 + n) },
        move: { chips: 10 },
      });
    }
    captureDrainedF06Originals() {
      return this.drainedF06Originals;
    }
  }
  const originals = events.map((event, n) => {
    const e: any = new f.Table(100 + n);
    e.running = false;
    e.terminal = true;
    e.terminalTeardownComplete = true;
    e.teardownPromise = Promise.resolve();
    e.dealingLoopPromise = null;
    e.seatBoundaryTail = Promise.resolve();
    e.snapshotFlushPromise = null;
    e.readContinuationTasks = new Set();
    e.tournamentMoveOperationByOwner = new Map();
    e.entryHoldWriteChains = new Map();
    e.f06HandPreparation = null;
    e.f06AllocationEpoch = null;
    e.lifecycleDiagnostics = { instanceId: uuid(85000 + n) };
    e.engineLeaseScope = 'tournament';
    e.engineLeaseVerified = true;
    e.engineLeaseTournamentId = event;
    e.engineLeaseGeneration = uuid(80000 + n);
    e.hasOnlyDrainedTournamentMoveOwner = () => true;
    e.timeBankEngine.playerBanks.clear();
    e.timeBankMeta.clear();
    e.f06CurrentPermit = new F06HandPermit(
      {
        tournament_id: event,
        lease_generation: e.engineLeaseGeneration,
        table_id: e.tableId,
        lifecycle: '1',
        permit_id: uuid(86000 + n),
        custody_id: uuid(87000 + n),
        hand_number: '17',
      },
      async () => {
        throw new Error('permit must never be actuated');
      },
      () => false
    );
    e.f06CurrentPermit.phase = 'reserved';
    const manager = new Manager(event, n, e);
    dataActorContext.bindTournamentDataAuthorityMethods(
      { tournamentId: event, leaseGeneration: e.engineLeaseGeneration },
      e
    );
    dataActorContext.bindTournamentDataAuthorityMethods(
      { tournamentId: event, leaseGeneration: e.engineLeaseGeneration },
      manager
    );
    f.server.tournamentEngines.set(event, manager);
    f.server.tableEngines.set(e.tableId, e);
    f.server.tournamentOwnedTables.add(e.tableId);
    return { engine: e, manager };
  });
  Object.assign(f.modules, {
    manager: { TournamentManager: Manager },
    managerBase: { TournamentManagerBase: Manager },
    permit: { F06HandPermit },
    retirement: { TournamentRetirementCustody },
  });
  const intent = {
    source: checkpoint8825,
    instance: '1-3846b8bb',
    container: 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66',
    startedAt: '2026-09-18T21:55:50.88305198Z',
    hostPid: 1231816,
    runId: '123-1',
    controlSha: 'a'.repeat(40),
    retryAllowed: false,
    custody: events.map((tournament_id, n) => ({
      tournament_id,
      transfer_id: uuid(88000 + n),
      successor_generation: uuid(89000 + n),
    })),
  };
  Object.assign(f.options, { custodyIntent: intent });
  Object.assign(f.modules.client.supabase, {
    rpc: async (name: string, input: any) => {
      rpcCalls.push(name);
      onRpc?.(name, input);
      let data: any;
      if (name === 'fn_f06_prepare_mixed_manager_custody') {
        const canonical = {
          engine_lifecycles: [],
          pending_original_tables: [],
          original_evidence: input.p_local.engines
            .filter((e: any) => e.permit)
            .map((e: any) => ({
              binding: e.permit.binding,
              permit: { ...e.permit.binding, state: 'aborted_unsettled', evidence_id: uuid(90000) },
              evidence: {
                hand: { receipt_id: uuid(90000), permit_id: e.permit.binding.permit_id },
                receipt: {
                  receipt_id: uuid(90000),
                  outcome: 'aborted_unsettled',
                  expected: {
                    kind: 'retained_mtt_interruption_v1',
                    physical: {
                      manager_id: input.p_local.manager_id,
                      engine_id: e.engine_id,
                      container_id: intent.container,
                    },
                  },
                },
              },
            })),
        };
        const receipt = input.p_expected
          ? {
              transfer_id: input.p_transfer_id,
              tournament_id: input.p_tournament_id,
              origin_generation: input.p_origin_generation,
              successor_generation: input.p_successor_generation,
              local_proof: structuredClone(input.p_local),
              canonical_proof: canonical,
            }
          : null;
        if (receipt) receipts.set(input.p_tournament_id, receipt);
        data = {
          ok: true,
          transfer_id: input.p_transfer_id,
          tournament_id: input.p_tournament_id,
          origin_generation: input.p_origin_generation,
          successor_generation: input.p_successor_generation,
          local: input.p_local,
          canonical,
          receipt,
        };
      } else {
        expect(name).toBe('fn_f06_find_mixed_manager_custody');
        data = {
          ok: true,
          tournament_id: input.p_tournament_id,
          receipt: receipts.get(input.p_tournament_id),
        };
      }
      return { error: null, data: changeResponse ? changeResponse(name, data) : data };
    },
  });
  return {
    ...f,
    intent,
    originals,
    receipts,
    rpcCalls,
    onRpc: (cb: typeof onRpc) => {
      onRpc = cb;
    },
    changeResponse: (cb: typeof changeResponse) => {
      changeResponse = cb;
    },
  };
}

describe('exact 8825 retained original custody retirement', () => {
  it('keeps native readiness false until durable zero-credit custody and exact native CAS', async () => {
    const f = mixedFixture();
    expect(f.server.maintenanceBreak.readyForRestart()).toBe(false);
    const identities = f.originals.map(({ engine, manager }) => [
      engine.f06CurrentPermit,
      manager.pendingTournamentSeatMoveOutcomes,
    ]);
    expect(await f.run()).toMatchObject({
      ok: true,
      restartAuthorized: false,
      readyForRestart: true,
    });
    expect(f.receipts.size).toBe(2);
    expect(f.server.maintenanceBreak.readyForRestart()).toBe(true);
    f.originals.forEach(({ engine, manager }, i) => {
      expect(f.server.tableEngines.has(engine.tableId)).toBe(false);
      expect(manager.tableEngines.get(engine.tableId)).toBe(engine);
      expect(engine.f06CurrentPermit).toBe(identities[i][0]);
      expect(engine.f06CurrentPermit.recoveryState()).toBe('reserved');
      expect(manager.pendingTournamentSeatMoveOutcomes).toBe(identities[i][1]);
      expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(1);
    });
  });
  it.each([
    [
      'replaced global original',
      (f: any) => f.server.tableEngines.set(f.originals[0].engine.tableId, new f.Table(500)),
    ],
    [
      'pending read continuation',
      (f: any) => f.originals[0].engine.readContinuationTasks.add(Promise.resolve()),
    ],
    [
      'unknown accounting',
      (f: any) => (f.originals[0].engine.timeBankAccountingUnconfirmed = true),
    ],
    [
      'in-flight permit',
      (f: any) => (f.originals[0].engine.f06CurrentPermit.reserveInFlight = true),
    ],
    [
      'in-flight manager work',
      (f: any) => f.originals[0].manager.lifecycleJobs.add(Promise.resolve()),
    ],
    [
      'missing pending map',
      (f: any) => (f.originals[0].manager.pendingTournamentParkRequests = undefined),
    ],
    ['insufficient reserve', (f: any) => f.remaining(284999)],
    [
      'unrestorable prior bank',
      (f: any) =>
        f.originals[0].engine.timeBankMeta.set(uuid(10100), {
          initialSeconds: 90,
          baseSeconds: 30,
          dbConsumedSeconds: 0,
        }),
    ],
    ['changed process', (f: any) => (f.intent.container = 'b'.repeat(64))],
  ])('refuses %s without any retirement', async (_label, alter) => {
    const f = mixedFixture();
    alter(f);
    expect((await f.run()).ok).toBe(false);
    expect(f.server.tableEngines.size).toBe(3);
    expect(f.rpcCalls).toEqual([]);
  });
  it.each(['fn_f06_prepare_mixed_manager_custody', 'fn_f06_find_mixed_manager_custody'])(
    'refuses changed local identity across %s',
    async (name) => {
      const f = mixedFixture();
      f.onRpc((called) => {
        if (called === name) f.originals[0].manager.tournamentSeatMoveAuthorityRevision++;
      });
      expect((await f.run()).ok).toBe(false);
      expect(f.server.tableEngines.size).toBe(3);
    }
  );
  it.each(['original', 'canonical', 'readback', 'healthy'])(
    'refuses %s evidence loss without hiding originals',
    async (fault) => {
      const f = mixedFixture();
      f.changeResponse((name, data) => {
        if (fault === 'original' && data.canonical)
          data.canonical.pending_original_tables.push(uuid(100));
        if (fault === 'canonical' && data.receipt?.canonical_proof)
          data.receipt.canonical_proof = {};
        if (fault === 'readback' && name === 'fn_f06_find_mixed_manager_custody')
          data.receipt = null;
        if (fault === 'healthy') f.first.handController = {};
        return data;
      });
      expect((await f.run()).ok).toBe(false);
      expect(f.server.tableEngines.size).toBe(3);
    }
  );
  // 8825 originals were interrupted mid-hand. `beginTerminalBoundaryPersistence`
  // reserved an integer immediately before HandController.start, and the only
  // site that removes it runs inside that hand's settlement - unreachable once
  // the engine is stopped, because `lifecycleCanMutate()` gates the step that
  // calls it. The entry is the interruption being handed over, not live work.
  it('admits the reserved terminal boundary of an interrupted original and still retires it', async () => {
    const f = mixedFixture();
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
    expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true });
    expect(f.receipts.size).toBe(2);
    expect(f.server.tableEngines.has(f.originals[0].engine.tableId)).toBe(false);
    // Admitted, never discarded: the guard still mutates no engine state.
    expect(f.originals[0].engine.terminalBoundaryPendingGenerations.size).toBe(1);
  });
  it('refuses a reserved terminal boundary that no undischarged permit can discharge', async () => {
    const f = mixedFixture();
    // 'attempted' is outside the set `sealAndRetireOriginals` demands an
    // `aborted_unsettled` receipt for, so nothing downstream would prove it.
    f.originals[0].engine.f06CurrentPermit.phase = 'attempted';
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'mixed_original_work_not_drained',
      failedCheck: 'engineCollection.size',
      failedField: 'terminalBoundaryPendingGenerations',
      expected: '0',
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
  it('refuses more pending boundaries than one interrupted hand can explain', async () => {
    const f = mixedFixture();
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(8);
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'mixed_original_work_not_drained',
      failedCheck: 'engineCollection.size',
      failedField: 'terminalBoundaryPendingGenerations',
      expected: '1',
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
  it.each([
    ['settlementInFlight', (e: any) => e.settlementInFlight.add(Promise.resolve())],
    ['tournamentMoveOperations', (e: any) => e.tournamentMoveOperations.add(Promise.resolve())],
    ['readContinuationTasks', (e: any) => e.readContinuationTasks.add(Promise.resolve())],
    ['timeBankAccountingPending', (e: any) => e.timeBankAccountingPending.add(Promise.resolve())],
    ['tournamentMoveOperationByOwner', (e: any) => e.tournamentMoveOperationByOwner.set('a', 1)],
    ['entryHoldWriteChains', (e: any) => e.entryHoldWriteChains.set('a', 1)],
  ])('still refuses undrained %s on an interrupted original', async (field, fill) => {
    const f = mixedFixture();
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
    fill(f.originals[0].engine);
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'mixed_original_work_not_drained',
      failedCheck: 'engineCollection.size',
      failedField: field,
      expected: '0',
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
  it('still refuses a failed terminal boundary on an interrupted original', async () => {
    const f = mixedFixture();
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
    f.originals[0].engine.terminalBoundaryPersistenceFailed = true;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'mixed_original_work_not_drained',
      failedCheck: 'engine.terminalBoundaryPersistenceFailed',
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
});
