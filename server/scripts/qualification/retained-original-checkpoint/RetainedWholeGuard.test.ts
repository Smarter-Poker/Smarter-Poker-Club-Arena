import { afterEach, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as inspector from 'node:inspector';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as crypto from 'node:crypto';
const wire = vi.hoisted(() => ({
  originals: new Map<string, any>(),
  parked: new Map<string, any>(),
  committed: new Map<string, any>(),
  calls: [] as any[],
  clock: {} as any,
  onAttest: null as null | (() => void),
}));
vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => {
    const filters = new Map();
    const q: any = {
      select: () => q,
      eq: (key: string, value: any) => {
        filters.set(key, value);
        return q;
      },
      in: () => q,
      abortSignal: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: async () => ({
        data:
          table === 'engine_presence_parked'
            ? (wire.parked.get(filters.get('table_id')) ?? null)
            : table === 'hand_atomic_commits'
              ? (wire.committed.get(filters.get('table_id')) ?? null)
              : table === 'hand_history'
                ? wire.committed.get(filters.get('table_id'))
                  ? { id: wire.committed.get(filters.get('table_id')).hand_id }
                  : null
                : null,
        error: null,
      }),
      upsert: async (row: any) => {
        if (table !== 'engine_presence_parked') throw Error('Unexpected table write');
        wire.calls.push({ name: 'park', row: structuredClone(row) });
        wire.parked.set(row.table_id, structuredClone(row));
        return { error: null };
      },
    };
    return q;
  };
  const rpc = async (name: string, p: any) => {
    wire.calls.push({ name, p: structuredClone(p) });
    if (name === 'save_hand_state_snapshot') return { data: null, error: null };
    if (name === 'fn_f06_attest_frozen_hand_continuation') {
      await wire.onAttest?.();
      const o = wire.originals.get(p.p_table_id),
        b = o.original;
      if (
        p.p_tournament_id !== b.tournament_id ||
        p.p_hand_number !== b.hand_number ||
        p.p_sequence !== o.batch.sequence ||
        p.p_payload_sha256 !== wire.clock.encode(o).sha256
      )
        throw Error('Native attestation input differs');
      return {
        data: {
          ok: true,
          frozen: true,
          table_id: b.table_id,
          hand_number: b.hand_number,
          sequence: String(o.batch.sequence),
          sha256: wire.clock.encode(o).sha256,
          controller_sha256: wire.clock.hash(o.batch.controller),
          writer_generation: p.p_lease_generation,
          tournament_id: b.tournament_id,
          permit_id: b.permit_id,
          original_generation: b.lease_generation,
          lifecycle: b.lifecycle,
          custody_id: b.custody_id,
          announced_at: new Date(wire.clock.announcedAt).toISOString(),
          break_started_at: new Date(wire.clock.breakStartedAt).toISOString(),
          break_ends_at: new Date(wire.clock.breakEndsAt).toISOString(),
        },
        error: null,
      };
    }
    if (name === 'fn_park_stopped_time_bank_custody') {
      if (p.p_unstarted_permit_id) throw Error('Original permit must never be released');
      wire.parked.set(p.p_table_id, {
        table_id: p.p_table_id,
        parked_at: p.p_parked_at,
        engine_instance: p.p_engine_instance,
        disconnect_states: p.p_disconnect_states,
        time_bank_snapshot: {
          version: 1,
          parkedAt: p.p_parked_at,
          handNumber: p.p_hand_number,
          players: p.p_players,
        },
      });
      return {
        data: { ok: true, table_id: p.p_table_id, hand_number: p.p_hand_number },
        error: null,
      };
    }
    throw Error('Unexpected native call ' + name);
  };
  return { supabase: { from, rpc }, maintenanceSupabase: {} };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import * as gameServer from '../GameServer.js';
import * as lightningRegistry from '../lightning/LightningRegistry.js';
import * as lightningSupervisor from '../lightning/LightningSupervisor.js';
import * as lightningWorker from '../lightning/LightningClusterWorker.js';
import * as lightningFormation from '../lightning/LightningFormationGate.js';
import * as lightningHost from '../lightning/LightningHandHost.js';
import { parseLightningConfig } from '../lightning/LightningConfig.js';
import { LightningPresence } from '../lightning/LightningPresence.js';
import * as base from './ServerTableEngineBase.js';
import * as engine from './ServerTableEngine.js';
import * as controller from './HandController.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import * as privateContinuation from './PrivateHandContinuation.js';
import * as managerBase from '../tournament/TournamentManagerBase.js';
import { TournamentManager } from '../tournament/TournamentManager.js';
import * as manager from '../tournament/TournamentManager.js';
import { HandContinuationLane } from './HandContinuationLane.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import * as maintenanceModule from '../maintenance/MaintenanceBreak.js';
import * as freezeState from '../maintenance/freezeState.js';
import * as actor from '../services/supabase/dataActorContext.js';
import * as tableLease from '../services/tableLease.js';
import * as releaseIdentity from '../releaseIdentity.js';
import * as client from '../services/supabase/client.js';
const held: any[] = [];
afterEach(async () => {
  for (const e of held.splice(0)) await e.stop();
  freezeState.setMaintenanceFrozen(false);
  wire.calls.length = 0;
  wire.originals.clear();
  wire.parked.clear();
  wire.committed.clear();
  vi.useRealTimers();
  wire.onAttest = null;
  (lightningFormation.lightningFormationGate as any).entries.clear();
});
const id = (n: number) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`;
function chairs(n: number) {
  return [1, 2].map((seat) => ({
    seat,
    seat_number: seat,
    user_id: 'whole-' + n + '-' + seat,
    username: 'Player ' + seat,
    stack: 1000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    seat_id: id(n * 10 + seat),
    occupancy_id: id(n * 100 + seat),
    seat_joined_at: '2026-10-29T00:00:00Z',
  }));
}
function banks(e: any, seats: any[]) {
  for (const s of seats) {
    e.timeBankEngine.initializePlayer(e.tableId, s.user_id, {
      remainingSeconds: 27,
      usesRemaining: 1,
    });
    e.timeBankMeta.set(s.user_id, { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 13 });
  }
}
const wholeCases = [
  'positive',
  'lightning-pending-host',
  'lightning-registered-host',
  'lightning-unknown-formation',
  'lightning-worker-inflight',
  'lightning-supervisor-inflight',
  'lightning-late-pending-host',
  'lightning-unknown-schema',
  'lightning-detached-native-pre-gate',
  'lightning-missing-worker-census',
  'lightning-detached-unknown-host',
  'detached-drained',
  'detached-lifecycle-job',
  'detached-job-during-await',
  'missing-manager-census',
  'shadow-covered-permit',
  'shadow-held-reserved',
  'shadow-held-unknown',
  'shadow-held-zero-bank',
  'shadow-failed',
  'shadow-unretained',
  'shadow-retained-sequence',
  'shadow-retention-waiter',
  'shadow-newer-retained-sequence',
  'shadow-swapped-release-method',
];
it.each(wholeCases)('whole guard uses actual EED owners: %s', async (scenario) => {
  const sha = 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
  expect(releaseIdentity.ENGINE_RELEASE_IDENTITY.releaseSha).toBe(sha);
  const server: any = Object.assign(Object.create(gameServer.GameServer.prototype), {
    running: true,
    teardownPromise: null,
    lifecycleGeneration: 1,
    tableEngines: new Map(),
    tournamentEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
  });
  server.lightningRooms = new lightningRegistry.LightningRegistry();
  server.lightningHosting = new lightningRegistry.LightningHosting({
    registry: server.lightningRooms,
    backend: {} as any,
    hub: { sendToUser: () => {} } as any,
    leaseFor: () => null,
  });
  server.lightningSupervisor = new lightningSupervisor.LightningSupervisor({
    hosting: server.lightningHosting,
    presenceSource: () => [],
    frozen: freezeState.isMaintenanceFrozen,
  });
  const worker: any = new lightningWorker.LightningClusterWorker(
    id(70),
    parseLightningConfig(null),
    {
      rpc: {} as any,
      presence: new LightningPresence(() => []),
      frozen: freezeState.isMaintenanceFrozen,
      formationGate: lightningFormation.lightningFormationGate,
    }
  );
  server.lightningSupervisor.workers.set(id(70), worker);
  const m: any = actor.bindTournamentDataAuthorityMethods(
    { tournamentId: id(1), leaseGeneration: id(2) },
    new TournamentManager(id(1), server, id(2), performance.now() + 600000)
  );
  m.running = true;
  server.tournamentEngines.set(id(1), m);
  const now = Date.now(),
    maintenance: any = new maintenanceModule.MaintenanceBreak({ now: () => Date.now() } as any);
  Object.assign(maintenance, {
    phase: 'counting_down',
    announcedAt: now - 120000,
    breakStartedAt: now,
    breakEndsAt: now + 300000,
    durableConfirmed: true,
  });
  maintenance.lastDurableState = {
    phase: maintenance.phase,
    announcedAt: maintenance.announcedAt,
    breakStartedAt: maintenance.breakStartedAt,
    breakEndsAt: maintenance.breakEndsAt,
    reason: maintenance.reason,
    ownershipToken: maintenance.ownershipToken,
  };
  server.maintenanceBreak = maintenance;
  wire.clock = {
    ...maintenance.lastDurableState,
    encode: privateContinuation.encodePrivateHandContinuation,
    hash: (value: string) => crypto.createHash('sha256').update(value).digest('hex'),
  };
  freezeState.setMaintenanceFrozen(true);
  const objects: any[] = [],
    originals: any[] = [];
  const retiredManagers: any[] = [];
  if (scenario.startsWith('shadow-held-')) {
    // Real EED preparation, permit and Manager.stop. A legacy PLO6 roster
    // with eight seats reaches the deployed deck-capacity backstop (max seven).
    // The separate unknown-begin case uses two ordinary NLH seats. The native
    // branch waits before constructing a controller or initializing any bank.
    // Only the owned fake clock advances that existing 30s sleep.
    const oldManager: any = actor.bindTournamentDataAuthorityMethods(
      { tournamentId: id(1), leaseGeneration: id(2) },
      new TournamentManager(id(1), server, id(2), performance.now() + 600000)
    );
    const shadow: any = oldManager.createManagedTableEngine(id(90));
    held.push(shadow);
    objects.push(shadow);
    retiredManagers.push(oldManager);
    const completed = scenario === 'shadow-held-zero-bank' ? 0 : 1000042;
    const next = 1000043;
    shadow.handCount = completed;
    shadow.tableInfo = {
      id: id(90),
      tournament_id: id(1),
      small_blind: 10,
      big_blind: 20,
      ante: 0,
      game_variant: scenario === 'shadow-held-unknown' ? 'nlh' : 'plo6',
    };
    shadow.seatedPlayers = Array.from(
      { length: scenario === 'shadow-held-unknown' ? 2 : 8 },
      (_, i) => ({
        ...chairs(80 + i)[0],
        seat: i + 1,
        seat_number: i + 1,
      })
    );
    let releaseBegin!: () => void;
    const beginGate = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    const permit = new F06HandPermit(
      {
        tournament_id: id(1),
        table_id: id(90),
        hand_number: String(next),
        permit_id: id(800),
        lease_generation: id(2),
        lifecycle: '1',
        custody_id: id(801),
      },
      async (name) => {
        expect(name).toBe('fn_f06_begin_hand');
        if (scenario === 'shadow-held-unknown') await beginGate;
        return {
          data: { ok: true, state: 'reserved', ...permit.binding, generation: id(2) },
          error: null,
        };
      },
      () => oldManager.running && shadow.running && shadow.isCurrentEngine()
    );
    shadow.installF06Allocator(
      'owned-preparation',
      async () => next,
      () => shadow.isCurrentEngine(),
      '1'
    );
    shadow.installF06HandAdmission(() => permit);
    expect(shadow.claimProcessOwnership()).toBe(true);
    oldManager.running = true;
    shadow.running = true;
    oldManager.tableEngines.set(shadow.tableId, shadow);
    let preparationError: string | null = null;
    freezeState.setMaintenanceFrozen(false);
    vi.useFakeTimers();
    try {
      // The real loop owns and swallows this preparation error on its stopped
      // exit. Preserve that promise ownership without running another hand.
      shadow.dealingLoopPromise = shadow.dealHand(shadow.seatedPlayers).catch((error: Error) => {
        preparationError = error.message;
      });
      await vi.waitFor(() =>
        expect(permit.recoveryState()).toBe(
          scenario === 'shadow-held-unknown' ? 'unknown' : 'reserved'
        )
      );
      expect(shadow.handController).toBeNull();
      expect(shadow.timeBankEngine.getBanksForTable(shadow.tableId)).toEqual([]);
      const stop = oldManager.stop();
      expect(shadow.running).toBe(false);
      releaseBegin();
      await vi.advanceTimersByTimeAsync(30000);
      await stop;
    } finally {
      vi.useRealTimers();
      freezeState.setMaintenanceFrozen(true);
    }
    expect(permit.recoveryState()).toBe(
      scenario === 'shadow-held-unknown' ? 'unknown' : 'reserved'
    );
    expect(shadow.f06CurrentPermit).toBe(permit);
    expect(shadow.handCount).toBe(completed);
    expect(shadow.f06HandPreparation).toBeNull();
    expect(shadow.terminalTeardownComplete).toBe(true);
    expect(shadow.hasReleasedProcessOwnership()).toBe(true);
    expect(shadow.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    expect(oldManager.tableEngines.size).toBe(0);
    expect(preparationError).toBe(
      scenario === 'shadow-held-unknown'
        ? 'f06_owner_changed'
        : 'f06_prepared_cancellation_unproven'
    );
    if (completed)
      wire.committed.set(shadow.tableId, {
        hand_id: id(802),
        post_commit_completed_at: new Date().toISOString(),
        post_commit_result: { ok: true },
      });
  }
  for (const n of [3, 4]) {
    const seats = chairs(n),
      tableId = id(n),
      e: any = m.createManagedTableEngine(tableId);
    held.push(e);
    objects.push(e);
    const clock = new PreciseActionTimer();
    // Native persisted input producer, not an admitted concrete dealer omitted from census.
    const donor: any = {
      ...structuredClone(e.captureContinuationEngine().fields),
      tableId,
      timeBankMeta: new Map(),
      unresolvedTimeBankDebits: new Map(),
      timeBankEngine: new TimeBankEngine(clock),
      disconnectEngine: new DisconnectEngine(clock),
    };
    const hc = new controller.HandController(
      {
        tableId,
        handNumber: 42,
        gameVariant: 'nlh',
        smallBlind: 10,
        bigBlind: 20,
        ante: 0,
        isTournament: true,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      },
      seats,
      1
    );
    if (n === 3) hc.start();
    donor.handController = hc;
    donor.currentHandDealerSeat = hc.getState().dealerSeat;
    donor.currentHandDealtStacks = new Map(seats.map((s) => [s.user_id, s.stack]));
    donor.currentHandSeatGenerations = new Map(
      seats.map((s) => [s.user_id, { seat_id: s.seat_id, seat_joined_at: s.seat_joined_at }])
    );
    banks(donor, seats);
    const binding = {
      tournament_id: id(1),
      table_id: tableId,
      hand_number: '42',
      permit_id: id(n + 10),
      lease_generation: id(2),
      lifecycle: '1',
      custody_id: id(n + 20),
    };
    const packet = privateContinuation.encodePrivateHandContinuation({
      version: 1,
      original: binding,
      seats: seats.map((s) => ({
        user_id: s.user_id,
        seat_id: s.seat_id,
        seat_joined_at: s.seat_joined_at,
        stack_before: s.stack,
      })),
      batch: {
        version: 1,
        sequence: n === 3 ? 3 : 0,
        controller: hc.serializeRecoveryState(),
        events: [],
        engine: base.ServerTableEngineBase.prototype.captureContinuationEngine.call(donor),
      },
    });
    const original = privateContinuation.decodePrivateHandContinuation(
      packet.payload,
      packet.sha256
    );
    donor.timeBankEngine.disposeAll();
    donor.disconnectEngine.disposeAll();
    clock.dispose();
    e.tableInfo = { id: tableId, tournament_id: id(1), small_blind: 10, big_blind: 20, ante: 0 };
    e.seatedPlayers = seats;
    e.installOriginalHandContinuation(
      original,
      new F06HandPermit(
        binding,
        async () => {
          throw Error('Unexpected permit write');
        },
        () => e.isCurrentEngine(),
        () => false,
        id(2)
      )
    );
    expect(e.claimProcessOwnership()).toBe(true);
    e.running = true;
    m.tableEngines.set(tableId, e);
    server.tableEngines.set(tableId, e);
    server.tournamentOwnedTables.add(tableId);
    e.pauseAfterHand(300000, { beforeNextHand: true, untilResumed: true });
    e.dealingLoopPromise = e.resumeOriginalController();
    await vi.waitFor(() => expect(typeof e.handForHandResolve).toBe('function'));
    e.pauseForMaintenance(300000);
    await e.presenceSave;
    wire.originals.set(tableId, original);
    originals.push({ e, original, packet, hc: e.handController });
  }
  const cash: any = new engine.ServerTableEngine(id(5), {
    scope: 'cash',
    verified: true,
    generation: id(6),
    proofDeadlineMonotonicMs: performance.now() + 600000,
  });
  held.push(cash);
  objects.push(cash);
  cash.tableInfo = { id: id(5), tournament_id: null };
  cash.handCount = 51;
  cash.seatedPlayers = chairs(5);
  banks(cash, cash.seatedPlayers);
  cash.disconnectEngine.registerPlayer(cash.tableId, cash.seatedPlayers[0].user_id);
  expect(cash.claimProcessOwnership()).toBe(true);
  cash.running = true;
  server.tableEngines.set(cash.tableId, cash);
  cash.pauseAfterHand(300000, { beforeNextHand: true, untilResumed: true });
  cash.dealingLoopPromise = cash.awaitPauseGate();
  cash.pauseForMaintenance(300000);
  await cash.presenceSave;
  const { retainedOriginalCheckpointGuard } = await import(
    /* @vite-ignore */ process.env.RETAINED_CHECKPOINT_GUARD_URL!
  );
  const modules = {
    gameServer,
    lightningRegistry,
    lightningSupervisor,
    lightningWorker,
    lightningFormation,
    base,
    engine,
    controller,
    manager,
    managerBase,
    maintenance: maintenanceModule,
    freezeState,
    releaseIdentity,
    tableLease,
    dataActorContext: actor,
    client,
    privateContinuation,
    permit: { F06HandPermit },
    crypto,
    fs: {
      readFileSync: (path: string) => {
        expect(path).toMatch(/^\/app\/dist\/[A-Za-z0-9/]+\.js$/);
        return readFileSync(
          join(process.env.RETAINED_CHECKPOINT_DIST_ROOT!, path.slice('/app/dist/'.length))
        );
      },
    },
  };
  const managers: any[] = [m, ...retiredManagers];
  if (scenario.startsWith('detached-')) {
    const detached: any = actor.bindTournamentDataAuthorityMethods(
      { tournamentId: id(60), leaseGeneration: id(61) },
      new TournamentManager(id(60), server, id(61), performance.now() + 600000)
    );
    await detached.stop();
    managers.push(detached);
    expect(detached.running).toBe(false);
    expect(detached.stopFenceApplied).toBe(true);
    if (scenario === 'detached-lifecycle-job') detached.lifecycleJobs.add(Promise.resolve());
    if (scenario === 'detached-job-during-await')
      wire.onAttest = () => detached.lifecycleJobs.add(Promise.resolve());
  }
  if (scenario.startsWith('shadow-') && !scenario.startsWith('shadow-held-')) {
    const shadow: any = m.createManagedTableEngine(originals[0].e.tableId);
    held.push(shadow);
    await shadow.stop();
    shadow.handCount = 42;
    shadow.pendingOriginalContinuation = originals[0].original;
    if (scenario === 'shadow-covered-permit')
      shadow.f06CurrentPermit = new F06HandPermit(
        originals[0].original.original,
        async () => {
          throw Error('Covered shadow must never write');
        },
        () => false,
        () => false,
        id(2)
      );
    const lane: any = new HandContinuationLane(
      3,
      () => originals[0].original.batch.controller,
      () => ({}),
      async () => {
        throw Error('A stopped shadow must never persist');
      },
      async () => {
        throw Error('A stopped shadow must never dispatch');
      },
      () => false,
      () => {}
    );
    lane.close();
    shadow.handContinuation = lane;
    if (scenario === 'shadow-failed') lane.failed = true;
    if (scenario === 'shadow-unretained') lane.unretainedBatches = 1;
    if (scenario === 'shadow-retained-sequence') lane.retainedSequence = 2;
    if (scenario === 'shadow-newer-retained-sequence') {
      lane.sequence = 4;
      lane.retainedSequence = 4;
    }
    if (scenario === 'shadow-swapped-release-method')
      shadow.hasReleasedProcessOwnership = () => true;
    if (scenario === 'shadow-retention-waiter')
      lane.retentionWaiters.push({ sequence: 4, resolve: () => {}, reject: () => {} });
    objects.push(shadow);
  }
  if (scenario === 'lightning-pending-host') server.lightningHosting.pending.add({});
  if (scenario === 'lightning-registered-host') server.lightningRooms.hosts.set(id(71), {});
  if (scenario === 'lightning-unknown-formation') {
    lightningFormation.lightningFormationGate.open(id(70), 'actual-unknown-request', now);
    lightningFormation.lightningFormationGate.close(id(70), 'actual-unknown-request', true, now);
  }
  if (scenario === 'lightning-worker-inflight') worker.inFlight = Promise.resolve();
  if (scenario === 'lightning-supervisor-inflight')
    server.lightningSupervisor.inFlight = Promise.resolve();
  if (scenario === 'lightning-late-pending-host')
    wire.onAttest = () => server.lightningHosting.pending.add({});
  if (scenario === 'lightning-unknown-schema') server.lightningRooms.hostByRoom = undefined;
  let releaseFrontLease: ((held: boolean) => void) | undefined;
  if (scenario === 'lightning-detached-native-pre-gate') {
    freezeState.setMaintenanceFrozen(false);
    worker.config = parseLightningConfig({ worker_mode: 'form' });
    worker.deps.startHand = () => {
      throw Error('Unexpected fixture hand formation');
    };
    worker.deps.holdsFrontTableLease = () =>
      new Promise<boolean>((resolve) => {
        releaseFrontLease = resolve;
      });
    worker.start();
    await vi.waitFor(() => expect(typeof releaseFrontLease).toBe('function'));
    expect(worker.inFlight).toBeInstanceOf(Promise);
    expect((lightningFormation.lightningFormationGate as any).entries.size).toBe(0);
    expect(server.lightningHosting.pending.size).toBe(0);
    server.lightningSupervisor.workers.clear();
    freezeState.setMaintenanceFrozen(true);
  }
  const detachedHosts: any[] = [];
  if (scenario === 'lightning-detached-unknown-host') {
    const host: any = new lightningHost.LightningHandHost(
      {
        clusterId: id(70),
        instanceId: id(71),
        handId: id(72),
        bb: id(73),
        sb: id(74),
        btn: id(73),
        players: [id(73), id(74)],
        formedAtMs: now,
      },
      { backend: {} as any, hub: {} as any, leaseFor: () => null }
    );
    host.state = 'settlement_unknown';
    detachedHosts.push(host);
    expect(server.lightningHosting.pending.size).toBe(0);
    expect(server.lightningRooms.hosts.size).toBe(0);
  }
  let census = [[server], objects, managers, [worker], detachedHosts];
  if (process.env.RETAINED_NATIVE_CENSUS_ADDON) {
    expect(process.version).toBe('v22.23.2');
    expect(process.versions.v8).toBe('12.4.254.21-node.56');
    const { createRequire } = await import('node:module');
    const native = createRequire(import.meta.url)(process.env.RETAINED_NATIVE_CENSUS_ADDON);
    const transport = await import(
      /* @vite-ignore */ process.env.RETAINED_NATIVE_CENSUS_TRANSPORT_URL!
    );
    expect(native.sourceSHA256).toBe(transport.LEGACY_CENSUS_NATIVE_SOURCE_SHA256);
    const key = '__legacyEngineCensus_' + crypto.randomUUID().replaceAll('-', '');
    const deadline = Date.now() + 30000;
    const imported = { gameServer, engine, manager, lightningWorker, lightningHost };
    transport.bindLegacyCensusModules.call(imported, key, deadline, native);
    // Exercise the actual external CDP -> marked collector -> nested Inspector
    // -> native callback path. The worker is only the external loopback client;
    // all original owners and the unchanged guard stay on this main isolate.
    expect(inspector.url()).toBeUndefined();
    inspector.open(0, '127.0.0.1');
    const resultKey = key + '_qualification';
    let client: Worker | undefined;
    let physical: any;
    try {
      await new Promise<void>((resolve, reject) => {
        client = new Worker(
          `
          const {parentPort,workerData}=require('node:worker_threads');
          const socket=new WebSocket(workerData.url);
          let id=0,pending;
          const timer=setTimeout(()=>{socket.close();parentPort.postMessage({ok:false,reason:'external CDP deadline'});},Math.max(1,workerData.deadline-Date.now()));
          function request(method,params){return new Promise((resolve,reject)=>{
            pending={id:++id,resolve,reject};socket.send(JSON.stringify({id,method,params}));
          });}
          socket.addEventListener('message',event=>{
            const answer=JSON.parse(String(event.data));
            if(answer.id!==pending?.id)return;
            const current=pending;pending=null;
            if(answer.error||answer.result?.exceptionDetails)current.reject(Error('external CDP evaluation refused'));
            else current.resolve(answer.result);
          });
          socket.addEventListener('error',()=>{clearTimeout(timer);parentPort.postMessage({ok:false,reason:'external CDP transport'});});
          socket.addEventListener('open',async()=>{
            try {
              await request('Runtime.evaluate',{expression:workerData.expression,disableBreaks:true,awaitPromise:false,objectGroup:'native-composition'});
              await request('Runtime.releaseObjectGroup',{objectGroup:'native-composition'});
              socket.addEventListener('close',()=>{clearTimeout(timer);parentPort.postMessage({ok:true});},{once:true});
              socket.close();
            }catch{clearTimeout(timer);socket.close();parentPort.postMessage({ok:false,reason:'external CDP refusal'});}
          });
        `,
          {
            eval: true,
            workerData: {
              url: inspector.url(),
              deadline: deadline + 5000,
              expression: `globalThis[${JSON.stringify(resultKey)}]=(${transport.collectMarkedLegacyCensus.toString()})(${JSON.stringify(key)},${deadline}); undefined`,
            },
          }
        );
        client.once('message', (message) =>
          message.ok === true ? resolve() : reject(Error(message.reason))
        );
        client.once('error', reject);
        client.once('exit', (code) => {
          if (code !== 0) reject(Error('external CDP client exited'));
        });
      });
      physical = (globalThis as any)[resultKey];
    } finally {
      await client?.terminate();
      delete (globalThis as any)[resultKey];
      inspector.close();
    }
    expect(inspector.url()).toBeUndefined();
    census = transport.projectLegacyCensus.call(physical, imported, deadline);
    const expected = [[server], objects, managers, [worker], detachedHosts];
    for (let group = 0; group < expected.length; group++) {
      expect(new Set(census[group]).size).toBe(expected[group].length);
      for (const original of expected[group]) expect(census[group]).toContain(original);
    }
    expect(Object.hasOwn(globalThis, key)).toBe(false);
  }
  const result = await retainedOriginalCheckpointGuard.call(
    server,
    {
      expectedReleaseSha: sha,
      expectedPid: process.pid,
      expectedInstanceId: tableLease.INSTANCE_ID,
    },
    census[0],
    modules,
    census[1],
    scenario === 'missing-manager-census' ? [] : census[2],
    scenario === 'lightning-missing-worker-census' ? [] : census[3],
    census[4]
  );
  if (releaseFrontLease) {
    releaseFrontLease(false);
    await worker.stop();
  }
  if (scenario.startsWith('shadow-held-'))
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      readyForRestart: false,
      stage: 'preflight',
      reason: 'retained_held_permit_unproven',
      attemptedTables: 0,
      completedCalls: 0,
      verifiedTables: 0,
    });
  if (!['positive', 'detached-drained', 'shadow-covered-permit'].includes(scenario)) {
    expect(result, scenario).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    for (const f of originals) expect(f.e.terminal).toBe(false);
    expect(cash.terminal).toBe(false);
    if (scenario.startsWith('lightning-')) return;
    expect(result.reason).toBe(
      scenario.startsWith('shadow-held-')
        ? 'retained_held_permit_unproven'
        : scenario === 'shadow-newer-retained-sequence'
          ? 'retained_shadow_disposition_unproven'
          : scenario === 'shadow-swapped-release-method'
            ? 'retained_method_owner_unproven'
            : scenario.startsWith('shadow-')
              ? 'retained_shadow_work_changed'
              : scenario === 'missing-manager-census'
                ? 'retained_manager_shape_unproven'
                : 'retained_detached_manager_work_unproven'
    );
    return;
  }

  expect(result, result.reason ?? 'whole guard positive').toMatchObject({
    ok: true,
    stage: 'complete',
    verifiedTables: 3,
    restartAuthorized: false,
  });
  for (const f of originals) {
    expect(privateContinuation.encodePrivateHandContinuation(f.original)).toEqual(f.packet);
    expect(f.hc.serializeRecoveryState()).toBe(f.original.batch.controller);
    expect(f.e.terminalTeardownComplete).toBe(true);
  }
  expect(cash.timeBankEngine.getBanksForTable(cash.tableId)).toEqual([]);
  expect(wire.parked.get(cash.tableId).time_bank_snapshot.players).toEqual(expect.any(Object));
  expect(wire.calls.filter((c) => c.name === 'fn_park_stopped_time_bank_custody')).toHaveLength(2);
  expect(wire.calls.every((c) => !c.p?.p_unstarted_permit_id)).toBe(true);
  expect(wire.calls.some((c) => /finish_hand|begin_hand|credit|debit|chip/.test(c.name))).toBe(
    false
  );
});
