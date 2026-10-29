import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as crypto from 'node:crypto';
const wire = vi.hoisted(() => ({
  originals: new Map<string, any>(),
  parked: new Map<string, any>(),
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
  wire.onAttest = null;
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
  'detached-drained',
  'detached-lifecycle-job',
  'detached-job-during-await',
  'missing-manager-census',
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
  const managers: any[] = [m];
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
  if (scenario.startsWith('shadow-')) {
    const shadow: any = m.createManagedTableEngine(originals[0].e.tableId);
    held.push(shadow);
    await shadow.stop();
    shadow.handCount = 42;
    shadow.pendingOriginalContinuation = originals[0].original;
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
  const result = await retainedOriginalCheckpointGuard.call(
    server,
    {
      expectedReleaseSha: sha,
      expectedPid: process.pid,
      expectedInstanceId: tableLease.INSTANCE_ID,
    },
    [server],
    modules,
    objects,
    scenario === 'missing-manager-census' ? [] : managers
  );
  if (!['positive', 'detached-drained'].includes(scenario)) {
    expect(result, scenario).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    for (const f of originals) expect(f.e.terminal).toBe(false);
    expect(cash.terminal).toBe(false);
    expect(result.reason).toBe(
      scenario === 'shadow-newer-retained-sequence'
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
