import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Contract of the serialized guard only. The maintained historical-runtime
// driver separately exercises real compiled EED engine owners and their stops.
const source = readFileSync(
  process.env.RETAINED_CHECKPOINT_CONTRACT_SOURCE ??
    fileURLToPath(new URL('../../scripts/retained-original-checkpoint-guard.mjs', import.meta.url)),
  'utf8'
);
const pins = new Map<string, string>(
  JSON.parse(
    source
      .slice(source.indexOf('const pins = ') + 13, source.indexOf('];') + 1)
      .replace(/'/g, '"')
      .replace(/,\s*]/g, ']')
  )
);
const guard = vm.runInNewContext(
  '(' + source.slice(source.indexOf('export async function')).replace('export ', '') + ')',
  {
    process,
    performance,
    Buffer,
    Date,
    Map,
    Set,
    Object,
    Number,
    JSON,
    Promise,
  }
) as (...args: any[]) => Promise<any>;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture({ cash = false, banks = true }: { cash?: boolean; banks?: boolean } = {}) {
  const now = Date.now();
  const table = id(1),
    tournament = id(2),
    generation = id(3),
    player = id(4),
    occupancy = id(5);
  let currentActor: unknown = null;
  const bind = (authority: any, callback: (...args: any[]) => any) =>
    function bound(this: unknown, ...args: any[]) {
      const previous = currentActor;
      currentActor = authority;
      try {
        return callback.apply(this, args);
      } finally {
        currentActor = previous;
      }
    };
  class MaintenanceBreak {}
  class GameServer {}
  const frozen = () => true;
  class LightningFormationGate {
    entries = new Map();
  }
  const lightningFormationGate = new LightningFormationGate();
  class LightningRegistry {
    hosts = new Map();
    hostByRoom = new Map();
  }
  class LightningHosting {
    pending = new Set();
    constructor(public deps: any) {}
  }
  class LightningSupervisor {
    workers = new Map();
    inFlight = null;
    stopOperation = null;
    frozen = frozen;
    constructor(public deps: any) {}
  }
  class LightningClusterWorker {
    inFlight = null;
    aaInFlight = null;
    pendingRequestId = null;
    frozen = frozen;
    gate = lightningFormationGate;
  }
  class HandController {
    serializeRecoveryState() {
      return 'actual-private-controller';
    }
  }
  class TournamentManagerBase {
    tournamentSeatMoveSerialTail = Promise.resolve();
    tournamentSeatMoveAuthorityRevision = 0;
    lifecycleEpoch = { token: null, controller: null };
    retainedTournamentBreakSources = new Map();
    pendingTournamentSeatMoveOutcomes = new Map();
    pendingTournamentParkRequests = new Map();
    pendingTournamentBreakBegins = new Map();
    pendingTournamentBreakAmendments = new Map();
    rejectedTournamentBreakBegins = new Map();
    resolvedTournamentBreakProposals = new Map();
    pendingTournamentBreakCustodyIds = new Map();
    pendingTournamentCleanupKinds = new Map();
    pendingNoStartContinuations = new Map();
    activeStoppedOriginalCustody = new Map();
    stoppedOriginalBreaks = new Map();
    tournamentBreakArrivalWakes = new Map();
    pendingTableBreakRetirement = null;
    mixedRecoveryOperation = null;
    capacityAdmissionOperation = null;
    seatMoveQuarantineRefusal() {
      return null;
    }
    captureDrainedF06Originals(this: any) {
      if (
        !this.drainedF06Originals ||
        !this.stopFenceApplied ||
        !this.tournamentLeaseAuthorityExpired ||
        this.running ||
        this.teardownPromise ||
        this.lifecycleOperation
      )
        return null;
      for (const name of [
        'lifecycleJobs',
        'tableEngineStartJobs',
        'tableEngineRunJobs',
        'eliminationSchedulerJobs',
        'lifecycleTimeouts',
        'lifecycleIntervals',
      ])
        if (this[name].size) return null;
      if (this.tableEngines.size !== this.drainedF06Originals.length) return null;
      for (const [tableId, engine] of this.drainedF06Originals)
        if (
          this.tableEngines.get(tableId) !== engine ||
          engine.isRunning() ||
          !engine.hasReleasedProcessOwnership() ||
          engine.hasSettlementInFlight()
        )
          return null;
      return this.drainedF06Originals;
    }
  }
  class TournamentManager extends TournamentManagerBase {}
  const bankRows: Record<string, any> = banks
    ? {
        [player]: {
          occupancyId: occupancy,
          remainingSeconds: 17,
          usesRemaining: 1,
          initialSeconds: 30,
          baseSeconds: 20,
          dbConsumedSeconds: 3,
        },
      }
    : {};
  const presence = { [player]: { state: 'CONNECTED', sinceMs: now - 20 } };
  const capture: any = {
    fields: { currentHandActions: [] },
    timeBankMeta: new Map(),
    timeBankDebits: new Map(),
    timeBanks: [],
    disconnectStates: presence,
    capturedAt: now - 10,
  };
  const original: any = cash
    ? null
    : {
        version: 1,
        original: {
          tournament_id: tournament,
          table_id: table,
          hand_number: '123',
          lifecycle: '4',
          permit_id: id(6),
          custody_id: id(7),
          lease_generation: id(8),
        },
        seats: [],
        batch: {
          version: 1,
          sequence: 7,
          controller: 'actual-private-controller',
          engine: structuredClone(capture),
          events: [],
        },
      };
  const rows = new Map<string, any>();
  const events: string[] = [];
  const controls: any = {
    onAttest: null,
    parkError: false,
    partialStop: false,
    unknownBank: false,
    changeCashAfterStop: false,
  };
  const snapshot = (stopped: boolean) => ({
    table_id: table,
    parked_at: new Date(now).toISOString(),
    engine_instance: `actual-process:${stopped ? 'stopped_custody' : 'parked'}`,
    disconnect_states: structuredClone(presence),
    time_bank_snapshot: {
      version: 1,
      handNumber: 123,
      parkedAt: new Date(now).toISOString(),
      players: structuredClone(bankRows),
    },
  });
  class ServerTableEngineBase {
    static liveEngines = new Map<string, any>();
    async stop(this: any) {
      events.push('stop');
      if (controls.partialStop) throw new Error('stop failed');
      this.terminal = true;
      this.running = false;
      this.terminalTeardownComplete = true;
      this.released = true;
      this.unretired = controls.unknownBank;
      if (!cash && banks) {
        this.stoppedTimeBankCustody = {
          handNumber: 123,
          banks: structuredClone(bankRows),
          disconnectStates: structuredClone(presence),
        };
        rows.set(table, snapshot(true));
      } else if (cash && controls.changeCashAfterStop)
        rows.set(table, { ...snapshot(false), engine_instance: 'foreign-process:parked' });
      ServerTableEngineBase.liveEngines.delete(table);
      server.tableEngines.delete(table);
    }
    async persistStoppedTimeBankCustody() {
      events.push('persist');
    }
    getEngineLeaseAuthority() {
      return {
        scope: cash ? 'cash' : 'tournament',
        verified: true,
        tournamentId: cash ? undefined : tournament,
        generation,
        proofDeadlineMonotonicMs: performance.now() + 1_000_000,
      };
    }
    captureContinuationEngine() {
      return structuredClone(capture);
    }
    captureParkedTimeBanks() {
      return structuredClone(bankRows);
    }
    hasUnretiredStoppedTimeBankCustody(this: any) {
      return this.unretired;
    }
    hasReleasedProcessOwnership(this: any) {
      return this.released;
    }
  }
  class ServerTableEngine extends ServerTableEngineBase {}
  const engine: any = Object.assign(new ServerTableEngine(), {
    tableId: table,
    handCount: 123,
    running: true,
    terminal: false,
    terminalTeardownComplete: false,
    released: false,
    unretired: false,
    engineLeaseAuthorityExpired: false,
    isRunning() {
      return this.running;
    },
    hasSettlementInFlight() {
      return this.settlementInFlight.size !== 0;
    },
    maintenancePaused: true,
    isCurrentEngine: () => true,
    lifecycleCanMutate: () => true,
    isBetweenHands: () => cash,
    handController: cash ? null : new HandController(),
    pendingOriginalContinuation: original,
    handContinuation: null,
    seatedPlayers: [
      {
        user_id: player,
        occupancy_id: occupancy,
        id: id(9),
        joined_at: new Date(now - 1000).toISOString(),
      },
    ],
    settlementInFlight: new Set(),
    tournamentMoveOperations: new Set(),
    readContinuationTasks: new Set(),
    timeBankAccountingPending: new Set(),
    unresolvedTimeBankDebits: new Map(),
    entryHoldWriteChains: new Map(),
    postHandTasksPromise: null,
    snapshotFlushPromise: null,
    snapshotDirty: false,
    presenceSavePending: 0,
    timeBankAccountingUnconfirmed: false,
    actionLock: false,
    preparedOriginalRetentionUnconfirmed: false,
    captureRetainedPresence: () => structuredClone(presence),
    timeBankMeta: new Map(),
    parkedTimeBanks: {},
    timeBankEngine: {
      getBanksForTable: () =>
        Object.keys(bankRows).map((playerId) => ({ playerId, isActive: false, armed: false })),
    },
    parkedBankSaveComplete: true,
    isMaintenanceStateDurable: () => true,
    acknowledgedTimeBankPark: {
      handNumber: 123,
      banks: JSON.stringify(Object.entries(bankRows).sort(([a], [b]) => a.localeCompare(b))),
    },
  });
  const authority = Object.freeze({
    actor: 'tournament-manager',
    tournamentId: tournament,
    leaseGeneration: generation,
  });
  const wrap = (target: any, names: string[]) => {
    Object.defineProperty(target, Symbol('smarter.tournament-data-authority'), {
      value: authority,
    });
    for (const name of names) target[name] = bind(authority, target[name]);
  };
  const manager: any = cash
    ? null
    : Object.assign(new TournamentManager(), {
        tournamentId: tournament,
        tableEngines: new Map([[table, engine]]),
        running: true,
        teardownPromise: null,
        stopRequested: false,
        tournamentLeaseGeneration: generation,
        tournamentLeaseAuthorityExpired: false,
        tournamentLeaseProofDeadlineMonotonicMs: performance.now() + 1_000_000,
        stopFenceApplied: false,
        lifecycleOperation: null,
        drainedF06Originals: null as readonly (readonly [string, any])[] | null,
        lifecycleJobs: new Set(),
        tableEngineStartJobs: new Set(),
        tableEngineRunJobs: new Set(),
        eliminationSchedulerJobs: new Set(),
        lifecycleTimeouts: new Set(),
        lifecycleIntervals: new Set(),
        async stop() {
          await engine.stop();
          this.running = false;
          this.stopFenceApplied = true;
          this.drainedF06Originals = Object.freeze(
            [...this.tableEngines].map((entry) => Object.freeze(entry))
          );
          this.tableEngines.clear();
        },
      });
  if (!cash) {
    wrap(engine, [
      'stop',
      'persistStoppedTimeBankCustody',
      'getEngineLeaseAuthority',
      'captureContinuationEngine',
      'captureParkedTimeBanks',
      'hasUnretiredStoppedTimeBankCustody',
      'hasReleasedProcessOwnership',
    ]);
    wrap(manager, ['stop', 'captureDrainedF06Originals', 'seatMoveQuarantineRefusal']);
  }
  const maintenance: any = Object.assign(new MaintenanceBreak(), {
    phase: 'counting_down',
    announcedAt: now - 120_000,
    breakStartedAt: now - 60_000,
    breakEndsAt: now + 300_000,
    reason: 'qualified-maintenance',
    ownershipToken: id(10),
    lifecycleGeneration: 1,
    resumeToken: 1,
    durableConfirmed: true,
    ending: false,
    stopOperation: null,
    releaseBoundaryOnly: false,
    recoveryReadPending: false,
    remainingMs: () => 300_000,
  });
  maintenance.lastDurableState = Object.fromEntries(
    ['phase', 'announcedAt', 'breakStartedAt', 'breakEndsAt', 'reason', 'ownershipToken'].map(
      (k) => [k, maintenance[k]]
    )
  );
  const server: any = Object.assign(new GameServer(), {
    maintenanceBreak: maintenance,
    running: true,
    teardownPromise: null,
    lifecycleGeneration: 1,
    tableEngines: new Map(cash ? [[table, engine]] : []),
    tournamentEngines: new Map(cash ? [] : [[tournament, manager]]),
  });
  server.lightningRooms = new LightningRegistry();
  server.lightningHosting = new LightningHosting({ registry: server.lightningRooms });
  server.lightningSupervisor = new LightningSupervisor({ hosting: server.lightningHosting });
  const lightningWorker = new LightningClusterWorker();
  server.lightningSupervisor.workers.set('idle-cluster', lightningWorker);
  const discoveredLightningWorkers = [lightningWorker];
  const discoveredLightningHosts: unknown[] = [];
  ServerTableEngineBase.liveEngines.set(table, engine);
  rows.set(table, snapshot(false));
  const encode = (v: any) => {
    const payload = JSON.stringify(v);
    return { payload, sha256: sha(payload) };
  };
  const modules: any = {
    crypto: {
      createHash: () => {
        let bytes: any;
        return {
          update(value: any) {
            bytes = value;
            return this;
          },
          digest() {
            return pins.get(String(bytes)) ?? createHash('sha256').update(bytes).digest('hex');
          },
        };
      },
    },
    fs: { readFileSync: (path: string) => Buffer.from(path) },
    releaseIdentity: {
      ENGINE_RELEASE_IDENTITY: { releaseSha: 'eed06fe51dea622069c661a6213d5b031ff3a9e3' },
    },
    tableLease: { INSTANCE_ID: 'actual-process' },
    gameServer: { GameServer },
    lightningRegistry: { LightningRegistry, LightningHosting },
    lightningSupervisor: { LightningSupervisor },
    lightningWorker: { LightningClusterWorker },
    lightningFormation: { LightningFormationGate, lightningFormationGate },
    base: { ServerTableEngineBase },
    engine: { ServerTableEngine },
    maintenance: { MaintenanceBreak },
    managerBase: { TournamentManagerBase },
    manager: { TournamentManager },
    controller: { HandController },
    dataActorContext: {
      bindTournamentDataAuthority: bind,
      currentTournamentDataAuthority: () => currentActor,
    },
    freezeState: { isMaintenanceFrozen: frozen },
    privateContinuation: { encodePrivateHandContinuation: encode },
    client: {
      supabase: {
        async rpc(name: string, args: any) {
          events.push('attest');
          expect(name).toBe('fn_f06_attest_frozen_hand_continuation');
          expect(args).toEqual({
            p_tournament_id: tournament,
            p_lease_generation: generation,
            p_table_id: table,
            p_hand_number: '123',
            p_sequence: 7,
            p_payload_sha256: encode(original).sha256,
          });
          expect(currentActor).toMatchObject({
            tournamentId: tournament,
            leaseGeneration: generation,
          });
          await controls.onAttest?.();
          if (controls.nativeError) return { data: null, error: new Error('native refusal') };
          const o = original.original;
          return {
            error: null,
            data: {
              ok: true,
              frozen: true,
              table_id: table,
              hand_number: o.hand_number,
              sequence: String(original.batch.sequence),
              sha256: encode(original).sha256,
              controller_sha256: sha(original.batch.controller),
              writer_generation: generation,
              tournament_id: tournament,
              permit_id: o.permit_id,
              original_generation: o.lease_generation,
              lifecycle: o.lifecycle,
              custody_id: o.custody_id,
              announced_at: new Date(maintenance.announcedAt).toISOString(),
              break_started_at: new Date(maintenance.breakStartedAt).toISOString(),
              break_ends_at: new Date(maintenance.breakEndsAt).toISOString(),
            },
          };
        },
        from(name: string) {
          expect(name).toBe('engine_presence_parked');
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  events.push('readPark');
                  return controls.parkError
                    ? { data: null, error: new Error('unknown read') }
                    : { data: rows.get(table), error: null };
                },
              }),
            }),
          };
        },
      },
    },
  };
  const discoveredManagers = manager ? [manager] : [];
  const addDetachedManager = () => {
    const detached: any = Object.assign(new TournamentManager(), {
      tournamentId: id(50),
      tableEngines: new Map(),
      running: false,
      teardownPromise: null,
      lifecycleOperation: null,
      tournamentLeaseGeneration: id(51),
      tournamentLeaseAuthorityExpired: true,
      stopFenceApplied: true,
      drainedF06Originals: Object.freeze([]),
      lifecycleJobs: new Set(),
      tableEngineStartJobs: new Set(),
      tableEngineRunJobs: new Set(),
      eliminationSchedulerJobs: new Set(),
      lifecycleTimeouts: new Set(),
      lifecycleIntervals: new Set(),
      async stop() {
        throw new Error('A detached drained manager must never be stopped again');
      },
    });
    const detachedAuthority = Object.freeze({
      actor: 'tournament-manager',
      tournamentId: detached.tournamentId,
      leaseGeneration: detached.tournamentLeaseGeneration,
    });
    Object.defineProperty(detached, Symbol('smarter.tournament-data-authority'), {
      value: detachedAuthority,
    });
    detached.stop = bind(detachedAuthority, detached.stop);
    detached.captureDrainedF06Originals = bind(
      detachedAuthority,
      detached.captureDrainedF06Originals
    );
    detached.seatMoveQuarantineRefusal = bind(
      detachedAuthority,
      detached.seatMoveQuarantineRefusal
    );
    discoveredManagers.push(detached);
    return detached;
  };
  return {
    addDetachedManager,
    lightningFormationGate,
    lightningWorker,
    discoveredLightningWorkers,
    discoveredLightningHosts,
    discoveredManagers,
    engine,
    manager,
    maintenance,
    server,
    controls,
    events,
    capture,
    original,
    rows,
    table,
    run: () =>
      guard.call(
        server,
        {
          expectedReleaseSha: modules.releaseIdentity.ENGINE_RELEASE_IDENTITY.releaseSha,
          expectedPid: process.pid,
          expectedInstanceId: 'actual-process',
        },
        [server],
        modules,
        [engine],
        discoveredManagers,
        discoveredLightningWorkers,
        discoveredLightningHosts
      ),
  };
}

describe('serialized retained-original guard owner contract', () => {
  it('accepts the actual93051 string-sequence response and stops only after native attestation', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({ ok: true, restartAuthorized: false, verifiedTables: 1 });
    expect(f.events).toEqual(['attest', 'stop', 'attest', 'readPark']);
  });
  it('keeps the original and calls no stop on a native error', async () => {
    const f = fixture();
    f.controls.nativeError = true;
    const original = f.original;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_native_original_unproven',
      attemptedTables: 0,
    });
    expect(f.engine.pendingOriginalContinuation).toBe(original);
    expect(f.events).not.toContain('stop');
  });
  it('refuses changed full engine capture during the attestation await before the first stop', async () => {
    const f = fixture();
    f.controls.onAttest = () => {
      f.capture.fields.currentHandActions.push('accepted-action');
    };
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_pre_stop_capture_changed',
      attemptedTables: 0,
    });
    expect(f.events).not.toContain('stop');
  });
  it('refuses changed manager child membership during an await before the first stop', async () => {
    const f = fixture();
    f.controls.onAttest = () => f.manager.tableEngines.clear();
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_manager_children_changed',
      attemptedTables: 0,
    });
    expect(f.events).not.toContain('stop');
  });
  it('requires exact cash native park acknowledgement and readback before stop, unchanged after', async () => {
    const f = fixture({ cash: true });
    expect(await f.run()).toMatchObject({ ok: true, verifiedTables: 1 });
    expect(f.events).toEqual(['readPark', 'stop', 'persist', 'readPark']);
  });
  it('accepts a genuinely empty cash owner without inventing a native park acknowledgement', async () => {
    const f = fixture({ cash: true, banks: false });
    f.engine.seatedPlayers = [];
    f.engine.captureRetainedPresence = () => ({});
    f.engine.acknowledgedTimeBankPark = null;
    f.engine.parkedBankSaveComplete = false;
    f.rows.clear();
    expect(await f.run()).toMatchObject({ ok: true, verifiedTables: 1 });
    expect(f.events).toEqual(['stop', 'persist']);
  });
  it('does not treat nonempty zero-bank presence as an empty owner without an ACK', async () => {
    const f = fixture({ cash: true, banks: false });
    f.engine.acknowledgedTimeBankPark = null;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_cash_park_ack_unproven',
      attemptedTables: 0,
    });
    expect(f.events).not.toContain('stop');
  });
  it('accepts a native positively drained detached manager with an empty exact engine census', async () => {
    const f = fixture();
    f.addDetachedManager();
    expect(await f.run()).toMatchObject({ ok: true, verifiedTables: 1 });
  });
  it('refuses an empty-engine detached manager that still owns a lifecycle job', async () => {
    const f = fixture();
    const detached = f.addDetachedManager();
    detached.lifecycleJobs.add(Promise.resolve());
    expect(await f.run()).toMatchObject({ ok: false, attemptedTables: 0 });
    expect(f.events).not.toContain('stop');
  });
  it('rechecks detached manager lifecycle work added during the native await before any stop', async () => {
    const f = fixture();
    const detached = f.addDetachedManager();
    f.controls.onAttest = () => detached.lifecycleJobs.add(Promise.resolve());
    expect(await f.run()).toMatchObject({ ok: false, attemptedTables: 0 });
    expect(f.events).not.toContain('stop');
  });
  it('refuses an unacknowledged cash park before stop', async () => {
    const f = fixture({ cash: true });
    f.engine.acknowledgedTimeBankPark = null;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_cash_park_ack_unproven',
      attemptedTables: 0,
    });
    expect(f.events).not.toContain('stop');
  });
  it('refuses a mismatched cash bank readback before the first stop', async () => {
    const f = fixture({ cash: true });
    f.rows.get(f.table).time_bank_snapshot.players = {};
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_native_park_unproven',
      attemptedTables: 0,
    });
    expect(f.events).not.toContain('stop');
  });
  it('refuses a cash row changed after stop', async () => {
    const f = fixture({ cash: true });
    f.controls.changeCashAfterStop = true;
    expect(await f.run()).toMatchObject({ ok: false });
  });
  it('refuses a native row error with nonempty presence and zero banks before stop', async () => {
    const f = fixture({ banks: false });
    f.controls.parkError = true;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_native_park_unreadable',
      attemptedTables: 0,
    });
    expect(f.events).not.toContain('stop');
  });
  it('refuses an undefined maintenance owner schema before stop', async () => {
    const f = fixture();
    f.maintenance.recoveryReadPending = undefined;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_durable_freeze_unproven',
      attemptedTables: 0,
    });
    expect(f.events).not.toContain('stop');
  });
  it('reports partial stop as unconfirmed', async () => {
    const f = fixture();
    f.controls.partialStop = true;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_stop_failed',
      checkpointOutcome: 'unconfirmed',
      restartAuthorized: false,
    });
  });
  it('refuses an unknown stopped native bank', async () => {
    const f = fixture();
    f.controls.unknownBank = true;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'retained_stop_custody_unproven',
      restartAuthorized: false,
    });
  });
});

describe('Lightning ownership is part of the serialized checkpoint fleet', () => {
  it.each([
    'pending-host',
    'registered-host',
    'unknown-formation',
    'worker-inflight',
    'supervisor-inflight',
    'late-pending-host',
    'unknown-schema',
    'detached-worker-inflight',
    'missing-worker-census',
    'detached-host-census',
  ])('refuses %s before the first classic stop', async (scenario) => {
    const f = fixture();
    if (scenario === 'pending-host') f.server.lightningHosting.pending.add({});
    if (scenario === 'registered-host') f.server.lightningRooms.hosts.set('host', {});
    if (scenario === 'unknown-formation')
      f.lightningFormationGate.entries.set('cluster', {
        requestId: 'unknown',
        inFlight: false,
        unknownSinceMs: Date.now(),
      });
    if (scenario === 'detached-worker-inflight') {
      f.server.lightningSupervisor.workers.clear();
      (f.lightningWorker as any).inFlight = new Promise(() => {});
    }
    if (scenario === 'detached-host-census')
      f.discoveredLightningHosts.push({ state: 'settlement_unknown' });
    if (scenario === 'missing-worker-census') f.discoveredLightningWorkers.length = 0;
    if (scenario === 'worker-inflight') (f.lightningWorker as any).inFlight = Promise.resolve();
    if (scenario === 'supervisor-inflight')
      f.server.lightningSupervisor.inFlight = Promise.resolve();
    if (scenario === 'late-pending-host')
      f.controls.onAttest = () => f.server.lightningHosting.pending.add({});
    if (scenario === 'unknown-schema') f.server.lightningRooms.hostByRoom = undefined;
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    expect(f.events).not.toContain('stop');
  });
});
