import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as base from './ServerTableEngineBase.js';
import * as manager from '../tournament/TournamentManager.js';
import * as managerBase from '../tournament/TournamentManagerBase.js';
import * as gameServer from '../GameServer.js';
import * as maintenance from '../maintenance/MaintenanceBreak.js';
import * as freezeState from '../maintenance/freezeState.js';
import * as permitModule from '../services/F06HandPermit.js';
import * as retirement from '../services/TournamentRetirementCustody.js';
import * as dataActorContext from '../services/supabase/dataActorContext.js';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
// @ts-expect-error The serialized publisher artifact has no emitted declaration.
import { legacyEngineCheckpointGuard } from '../../scripts/legacy-engine-checkpoint-guard.mjs';
const checkpointIo = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: checkpointIo,
  maintenanceSupabase: {},
}));

vi.mock('../services/tableLease.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/tableLease.js')),
  INSTANCE_ID: '1-3846b8bb',
}));

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function engine(n: number): any {
  const value = new ServerTableEngine(id(n)) as any;
  value.flushSnapshot = vi.fn().mockResolvedValue(undefined);
  return value;
}
afterEach(() => vi.restoreAllMocks());

describe('bounded engine lifecycle observations', () => {
  it('reads retained work without joining and observes actual settlement before cleanup', async () => {
    const value = engine(701),
      raw = deferred();
    const owned = raw.promise.finally(() => value.settlementInFlight.delete(owned));
    value.settlementInFlight.add(owned);
    const stopping = value.stop();
    expect(value.stop()).toBe(stopping);
    const terminal = value.leavePendingLifecycleSnapshot().first_terminal;
    const pending = value.getLifecycleDiagnosticSnapshot();
    expect(pending.retainedWork).toMatchObject({ settlements: 1, readContinuations: null });
    expect(pending.readContinuationCoverage).toBe('unavailable_on_selected_base');
    expect(pending.leaseReleaseAck).toBe('unobserved-owner-boundary');
    expect(pending.records.map((row: any) => row.event)).toEqual(['stop_initiated']);
    expect(value.flushSnapshot).not.toHaveBeenCalled();
    expect(value.leavePendingLifecycleSnapshot().first_terminal).toEqual(terminal);
    raw.resolve();
    await stopping;
    expect(value.getLifecycleDiagnosticSnapshot().records.map((row: any) => row.event)).toEqual([
      'stop_initiated',
      'owned_work_joined',
      'stop_completed',
    ]);
    expect(value.stop()).toBe(stopping);
  });

  it('diagnostic write failure does not turn an actual failed writer into success', async () => {
    const value = engine(702),
      raw = deferred();
    const failure = new Error('owned writer rejected');
    const owned = raw.promise.finally(() => value.settlementInFlight.delete(owned));
    value.settlementInFlight.add(owned);
    vi.spyOn(value.lifecycleDiagnostics, 'record').mockImplementation(() => {
      throw new Error('diagnostic only');
    });
    const stopping = value.stop();
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: expect.arrayContaining([failure]),
    });
    raw.reject(failure);
    await rejected;
    expect(value.getLifecycleDiagnosticSnapshot().diagnosticWriteFailures).toBeGreaterThan(0);
    expect(value.getLifecycleDiagnosticSnapshot().leaseReleaseAck).toBe(
      'unobserved-owner-boundary'
    );
  });

  it('retains bounded immutable records and preserves existing terminal reason semantics', async () => {
    const value = engine(703);
    for (let i = 0; i < 40; i++)
      value.lifecycleDiagnostics.record('writer_pending', {
        attempt: i,
        payload: 'PRIVATE',
      } as any);
    const before = value.getLifecycleDiagnosticSnapshot();
    expect(before.records).toHaveLength(32);
    expect(before.droppedRecords).toBe(8);
    expect(JSON.stringify(before)).not.toContain('PRIVATE');
    expect(Object.isFrozen(before.records[0])).toBe(true);
    value.killForRestartPublic('tournament_lease_proof_expired');
    const originalTerminal = value.leavePendingLifecycleSnapshot().first_terminal;
    await value.stop();
    expect(value.leavePendingLifecycleSnapshot().first_terminal).toEqual(originalTerminal);
    expect(before.lastSequence).toBe(40);
    expect(
      value.getLifecycleDiagnosticSnapshot().records.some((r: any) => r.event === 'engine_fenced')
    ).toBe(true);
  });
});

// Native stop, ownership indexes, reservations and readiness. Only database I/O
// is isolated; the archived 8825 qualification executes these same cases on dist.
const release8825 = '8825af51817f379c4261658ca29ecc9d8d81932d';
const events8825 = ['5a387a75-754a-416e-8fee-b85b15fc2702', '615783bf-15e3-40b7-9368-75f21b6ac53b'];
const historicalCohorts = JSON.parse(
  readFileSync(
    new URL('../../../scripts/ci/probes/f06-historical-bank-loss-cohorts.json', import.meta.url),
    'utf8'
  )
);
const retiredCohorts = JSON.parse(
  readFileSync(
    new URL('../../../scripts/ci/probes/f06-retired-origin-cohorts.json', import.meta.url),
    'utf8'
  )
);
async function nativeCheckpoint(
  includeAcceptedOriginal = false,
  includeOriginalBank = false,
  historical = false
) {
  checkpointIo.rpc.mockReset();
  const bankRows = new Map();
  checkpointIo.from.mockReset().mockImplementation((table: string) => {
    expect(table).toBe('engine_presence_parked');
    let ids: string[] = [];
    const q: any = {
      select: () => q,
      upsert: async (row: any) => {
        bankRows.set(row.table_id, structuredClone(row));
        return { error: null };
      },
      in: (_key: string, values: string[]) => {
        ids = values;
        return q;
      },
      limit: async () => ({
        data: ids.flatMap((id) => (bankRows.has(id) ? [bankRows.get(id)] : [])),
        error: null,
      }),
    };
    return q;
  });
  const s: any = Object.create(gameServer.GameServer.prototype);
  Object.assign(s, {
    running: true,
    teardownPromise: null,
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentDiagnosticRetirements: new Map(),
    drainedF06TournamentCustody: new Map(),
    completedF06TournamentCustody: new Map(),
    tableEngineStartPromises: new Map(),
    directTableAdmissionOperations: new Map(),
    directTableRecoveryTimers: new Map(),
    directTableAdmissionLeaseGenerations: new Map(),
    directTablePendingLeaseReleases: new Map(),
    tournamentRetirementCustody: new retirement.TournamentRetirementCustody(),
  });
  const originals: any[] = [];
  for (let i = 0; i < events8825.length; i++) {
    const event = events8825[i],
      generation = historical ? historicalCohorts[event].generation : id(800 + i);
    const m: any = new manager.TournamentManager(event, s, generation, performance.now() + 30000);
    dataActorContext.bindTournamentDataAuthorityMethods(
      { tournamentId: event, leaseGeneration: generation },
      m
    );
    // originalTables[0] is the interrupted one: the single table the recorded
    // cohort names as holding the unsettled permit, not whichever sorts first.
    const interrupted = historical ? retiredCohorts[event].permit.table_id : id(810 + i);
    const originalTables = historical
      ? [
          interrupted,
          ...Object.keys(retiredCohorts[event].engines)
            .sort()
            .filter((t) => t !== interrupted),
        ]
      : [interrupted];
    const e: any = m.createManagedTableEngine(originalTables[0]);
    e.installF06Allocator(
      id(840 + i),
      async () => 1,
      () => true
    );
    const permit = new permitModule.F06HandPermit(
      {
        tournament_id: event,
        lease_generation: generation,
        table_id: e.tableId,
        lifecycle: '1',
        permit_id: id(830 + i),
        hand_number: '2',
        custody_id: id(840 + i),
      },
      async (_n, a) => ({
        error: null,
        data: {
          ok: true,
          tournament_id: a.p_tournament_id,
          generation: a.p_lease_generation,
          custody_id: a.p_custody_id,
          permit_id: a.p_permit_id,
          table_id: a.p_table_id,
          lifecycle: a.p_lifecycle,
          hand_number: a.p_hand_number,
          state: 'reserved',
        },
      }),
      () => true
    );
    await permit.reserve();
    e.installF06HandAdmission(() => permit);
    e.f06CurrentPermit = permit;
    m.tableEngines.set(e.tableId, e);
    s.tableEngines.set(e.tableId, e);
    s.tournamentOwnedTables.add(e.tableId);
    s.tournamentEngines.set(event, m);
    m.retainedTournamentBreakSources.set(e.tableId, { breakId: id(850 + i), engine: e });
    m.durableTournamentBreaks.set(id(850 + i), {
      lifecycle: '1',
      state: 'begun',
      revision: '1',
      members: [],
      custody_id: id(860 + i),
      custody_generation: generation,
      terminal_handoff_required: false,
    });
    const pending = {
      move: { fromTableId: e.tableId, toTableId: id(870 + i) },
      input: {
        requestId: id(880 + i),
        tournamentId: event,
        userId: id(890 + i),
        sourceTableId: e.tableId,
        destinationTableId: id(870 + i),
        destinationSeatNumber: 1,
        sourceMode: 'live_source',
      },
    };
    m.pendingTournamentSeatMoveOutcomes.set(id(880 + i), pending);
    if (includeOriginalBank) {
      const player = id(970 + i),
        occupancy = id(980 + i);
      e.seatedPlayers = [{ user_id: player, occupancy_id: occupancy, seat_number: 1, stack: 100 }];
      e.parkedTimeBanks = {
        [player]: {
          occupancyId: occupancy,
          remainingSeconds: 75,
          usesRemaining: 2,
          initialSeconds: 90,
          baseSeconds: 30,
          dbConsumedSeconds: 15,
          unlimitedActivations: true,
        },
      };
      e.applyParkedTimeBanks(e.seatedPlayers);
      const players = e.captureParkedTimeBanks();
      expect(players[player].unlimitedActivations).toBe(true);
      // Current-source stop additionally needs its actual acknowledged park.
      // The pinned 8825 run has no new custody state, and uses the same writer.
      await e.persistPresenceForRestart('parked');
      expect(bankRows.get(e.tableId).time_bank_snapshot.players).toEqual(players);
    }
    // An ordinary previously played table has neither a current permit nor a
    // movement admission. The actual accepted-hand method clears its permit,
    // retaining only the original allocator epoch as the historical witness.
    let accepted: any = null;
    if (includeAcceptedOriginal) {
      const played: any = m.createManagedTableEngine(id(930 + i));
      const binding = {
        tournament_id: event,
        lease_generation: generation,
        table_id: played.tableId,
        lifecycle: '1',
        permit_id: id(940 + i),
        hand_number: '3',
        custody_id: id(950 + i),
      };
      const evidenceId = id(960 + i);
      const oldPermit = new permitModule.F06HandPermit(
        binding,
        async (name) => ({
          error: null,
          data: {
            ok: true,
            ...binding,
            generation,
            state: name === 'fn_f06_begin_hand' ? 'reserved' : 'accepted',
            evidence_id: evidenceId,
          },
        }),
        () => true
      );
      played.installF06Allocator(
        binding.custody_id,
        async () => 4,
        () => true
      );
      played.installF06HandAdmission(() => oldPermit);
      await oldPermit.reserve();
      played.f06CurrentPermit = oldPermit;
      oldPermit.start(() => undefined);
      await played.finishF06AcceptedHand(binding.hand_number, evidenceId);
      expect(played.f06CurrentPermit).toBeNull();
      m.tableEngines.set(played.tableId, played);
      s.tableEngines.set(played.tableId, played);
      s.tournamentOwnedTables.add(played.tableId);
      accepted = {
        engine: played,
        oldPermit,
        row: {
          ...binding,
          generation,
          lifecycle: 1,
          hand_number: 3,
          state: 'accepted',
          evidence_id: evidenceId,
        },
        allocation: [played.f06Allocator, played.f06AllocationCurrent, played.f06PermitFactory],
      };
    }
    // The recorded cohort holds exactly ONE unsettled permit per event - the
    // single table that was mid-hand when the release stopped. Every other
    // original table was between hands: its last accepted hand cleared the
    // permit and left only the original allocator epoch as the witness. Giving
    // all 23 a live reserved permit would assert 14 and 9 simultaneously
    // interrupted hands, which the recorded originals do not show.
    const extras: any[] = [];
    for (const [index, tableId] of originalTables.slice(1).entries()) {
      const extra: any = m.createManagedTableEngine(tableId);
      const binding = {
        tournament_id: event,
        lease_generation: generation,
        table_id: tableId,
        lifecycle: '1',
        permit_id: id(1100 + i * 100 + index),
        hand_number: '3',
        custody_id: id(1200 + i * 100 + index),
      };
      const evidenceId = id(1300 + i * 100 + index);
      const extraPermit = new permitModule.F06HandPermit(
        binding,
        async (name: string) => ({
          error: null,
          data: {
            ok: true,
            ...binding,
            generation,
            state: name === 'fn_f06_begin_hand' ? 'reserved' : 'accepted',
            evidence_id: evidenceId,
          },
        }),
        () => true
      );
      extra.installF06Allocator(
        binding.custody_id,
        async () => 4,
        () => true
      );
      extra.installF06HandAdmission(() => extraPermit);
      await extraPermit.reserve();
      extra.f06CurrentPermit = extraPermit;
      extraPermit.start(() => undefined);
      await extra.finishF06AcceptedHand(binding.hand_number, evidenceId);
      expect(extra.f06CurrentPermit).toBeNull();
      expect(extra.f06AllocationEpoch).toBe(binding.custody_id);
      m.tableEngines.set(tableId, extra);
      s.tableEngines.set(tableId, extra);
      s.tournamentOwnedTables.add(tableId);
      extras.push({
        e: extra,
        permit: extraPermit,
        row: {
          ...binding,
          generation,
          lifecycle: 1,
          hand_number: 3,
          state: 'accepted',
          evidence_id: evidenceId,
        },
      });
    }
    vi.spyOn(m, 'resolveTournamentSeatMoveQuarantine').mockResolvedValue(false);
    m.fenceForTournamentLeaseLoss();
    await expect(m.stop()).rejects.toThrow('failed to stop');
    expect(m.captureDrainedF06Originals()).toEqual([
      [e.tableId, e],
      ...extras.map(({ e }) => [e.tableId, e]),
      ...(accepted ? [[accepted.engine.tableId, accepted.engine]] : []),
    ]);
    expect(
      e.getLifecycleDiagnosticSnapshot().records.some((r: any) => r.event === 'stop_completed')
    ).toBe(true);
    await expect(
      s.tournamentRetirementCustody.withCustody(
        {
          tournamentId: event,
          tableId: e.tableId,
          tableIncarnation: '1',
          leaseGeneration: generation,
          breakId: id(850 + i),
          custodyId: id(860 + i),
          durableRevision: '1',
        },
        s.tableEngines,
        m.tableEngines,
        () => true,
        async () => {
          throw new Error('original move result remains unresolved');
        },
        async () => undefined
      )
    ).rejects.toThrow('original move result remains unresolved');
    originals.push({
      m,
      e,
      extras,
      permit,
      pending,
      pendingMap: m.pendingTournamentSeatMoveOutcomes,
      localMap: m.tableEngines,
      binding: permit.binding,
      accepted,
    });
  }
  const b: any = new maintenance.MaintenanceBreak({
    engines: () => s.tableEngines,
    isRunning: () => true,
    emit: () => undefined,
  } as any);
  const now = Date.now();
  Object.assign(b, {
    phase: 'counting_down',
    announcedAt: now - 120000,
    breakStartedAt: now,
    breakEndsAt: now + 300000,
    durableConfirmed: true,
  });
  b.lastDurableState = Object.fromEntries(
    ['phase', 'announcedAt', 'breakStartedAt', 'breakEndsAt', 'reason', 'ownershipToken'].map(
      (key) => [key, b[key]]
    )
  );
  s.maintenanceBreak = b;
  freezeState.setMaintenanceFrozen(true);
  const receipts = new Map();
  let boundary: ((name: string, args: any) => void) | null = null;
  let changeResponse: ((data: any) => void) | null = null;
  checkpointIo.rpc.mockImplementation(async (name: string, a: any) => {
    boundary?.(name, a);
    if (name === 'fn_f06_find_mixed_manager_custody')
      return { error: null, data: { ok: true, receipt: receipts.get(a.p_tournament_id) } };
    expect(name).toBe('fn_f06_prepare_mixed_manager_custody');
    const o = originals.find((v) => v.m.tournamentId === a.p_tournament_id)!;
    const receiptId = id(900 + events8825.indexOf(a.p_tournament_id));
    const canonical = a.p_expected ?? {
      engine_lifecycles: [
        ...(o.accepted
          ? [
              {
                table_id: o.accepted.engine.tableId,
                allocation_epoch: o.accepted.row.custody_id,
                lifecycle: '1',
                // smarter_private.f06_mixed_custody_snapshot names its witness
                // since migration 20260924225647: 'permits' for an epoch that
                // reserved, 'never_reserved' for one that never did.
                witness: 'permits',
                permits: [structuredClone(o.accepted.row)],
              },
            ]
          : []),
        ...o.extras.map((extra: any) => ({
          table_id: extra.e.tableId,
          allocation_epoch: extra.row.custody_id,
          lifecycle: '1',
          witness: 'permits',
          permits: [structuredClone(extra.row)],
        })),
      ],
      pending_original_tables: [],
      original_evidence: [o].map((original) => ({
        binding: original.permit.binding,
        permit: { ...original.permit.binding, state: 'aborted_unsettled', evidence_id: receiptId },
        evidence: {
          hand: { receipt_id: receiptId, permit_id: original.permit.binding.permit_id },
          receipt: {
            receipt_id: receiptId,
            outcome: 'aborted_unsettled',
            expected: {
              kind: 'retained_mtt_interruption_v1',
              physical: {
                manager_id: a.p_local.manager_id,
                engine_id: a.p_local.engines.find((e: any) => e.table_id === original.e.tableId)
                  .engine_id,
                container_id: options.custodyIntent.container,
              },
            },
          },
        },
      })),
    };
    if (historical && !a.p_expected) {
      const scope = historicalCohorts[a.p_tournament_id];
      const allowance = (user_id: string) => ({
        user_id,
        is_vip: true,
        is_lifetime: true,
        unlimited_activations: true,
        vip_seconds_remaining: null,
        purchased_seconds: 0,
        extra_seconds: 0,
      });
      const bank = (occupancyId: string) => ({
        occupancyId,
        remainingSeconds: 40,
        usesRemaining: 2,
        initialSeconds: 40,
        baseSeconds: 40,
        dbConsumedSeconds: 0,
        unlimitedActivations: true,
      });
      (canonical as any).historical_loss = {
        kind: scope.kind,
        original_receipt_id: scope.receipt_id,
        plans: a.p_local.engines.map((e: any) => ({
          table_id: e.table_id,
          disposition: {
            old_final_balance: 'unknown',
            old_debit_outcomes: 'retained_not_replayed',
            initialization: 'ordinary_lifetime_session',
            disposition: e.bank_custody.historical_loss,
            observations: scope.occupants
              .filter((o: any) => o.table_id === e.table_id)
              .map((original: any) => ({ original, allowance: allowance(original.user_id) })),
          },
          normal_session: Object.fromEntries(
            scope.occupants
              .filter((o: any) => o.table_id === e.table_id)
              .map((o: any) => [o.user_id, bank(o.occupancy_id)])
          ),
        })),
        pending_arrivals: scope.pending_arrivals.map((original: any) => ({
          source: { table_id: original.table_id },
          proof: {
            historical_loss: {
              original_kind: original.kind,
              observations: [{ original, allowance: allowance(original.user_id) }],
            },
            presence: {
              time_bank_snapshot: { players: { [original.user_id]: bank(original.occupancy_id) } },
            },
          },
        })),
      };
    }
    const receipt = a.p_expected
      ? {
          transfer_id: a.p_transfer_id,
          tournament_id: a.p_tournament_id,
          origin_generation: a.p_origin_generation,
          successor_generation: a.p_successor_generation,
          local_proof: a.p_local,
          canonical_proof: canonical,
          created_at: new Date().toISOString(),
        }
      : null;
    if (receipt) receipts.set(a.p_tournament_id, structuredClone(receipt));
    const data = {
      ok: true,
      transfer_id: a.p_transfer_id,
      tournament_id: a.p_tournament_id,
      origin_generation: a.p_origin_generation,
      successor_generation: a.p_successor_generation,
      local: a.p_local,
      canonical,
      receipt,
    };
    changeResponse?.(data);
    return { error: null, data };
  });
  const options = {
    expectedReleaseSha: release8825,
    expectedInstanceId: '1-3846b8bb',
    expectedPid: process.pid,
    custodyIntent: {
      source: release8825,
      instance: '1-3846b8bb',
      container: 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66',
      startedAt: '2026-09-18T21:55:50.88305198Z',
      hostPid: 1231816,
      runId: '35400000000-1',
      controlSha: 'a'.repeat(40),
      retryAllowed: false,
      custody: events8825.map((tournament_id, i) => ({
        tournament_id,
        transfer_id: id(910 + i),
        successor_generation: id(920 + i),
      })),
    },
  };
  // Independent file-admission cases cover pins. This current-source test isolates
  // native behavior; the archived qualification sets a root and hashes real bytes.
  const text = readFileSync(
    new URL('../../scripts/legacy-engine-checkpoint-guard.mjs', import.meta.url),
    'utf8'
  );
  const pins = new Map(
    [...text.matchAll(/\[\s*'(\/app\/dist\/[^']+)',\s*'([a-f0-9]{64})',?\s*\]/g)]
      .slice(0, 14)
      .map((v) => [v[1], v[2]])
  );
  expect(pins.size).toBe(14);
  const artifactRoot = process.env.LEGACY_CHECKPOINT_ARTIFACT_ROOT;
  const modules = {
    gameServer,
    base,
    manager,
    managerBase,
    maintenance,
    freezeState,
    permit: permitModule,
    retirement,
    dataActorContext,
    client: { supabase: checkpointIo },
    releaseIdentity: { ENGINE_RELEASE_IDENTITY: { releaseSha: release8825, version: '8825af51' } },
    tableLease: { INSTANCE_ID: '1-3846b8bb' },
    fs: artifactRoot
      ? {
          statSync: (p: string) => statSync(p.replace('/app', artifactRoot)),
          readFileSync: (p: string) => readFileSync(p.replace('/app', artifactRoot)),
        }
      : {
          statSync: () => ({ isFile: () => true, size: 1 }),
          readFileSync: (p: string) => Buffer.from([Array.from(pins.keys()).indexOf(p)]),
        },
    crypto: artifactRoot
      ? { createHash }
      : {
          createHash: () => ({
            update: (v: Buffer) => ({
              digest: () => Array.from(pins.values())[v[0]],
            }),
          }),
        },
  };
  return {
    s,
    originals,
    receipts,
    bankRows,
    b,
    run: () => legacyEngineCheckpointGuard.call(s, options, [s], modules),
    onBoundary: (fn: typeof boundary) => {
      boundary = fn;
    },
    changeResponse: (fn: typeof changeResponse) => {
      changeResponse = fn;
    },
  };
}
afterEach(() => freezeState.setMaintenanceFrozen(false));
describe('native retained 8825 release checkpoint', () => {
  it('retains the exact native original bank snapshot after stop disposes live banks', async () => {
    const f = await nativeCheckpoint(false, true);
    const prior = structuredClone([...f.bankRows]);
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, readyForRestart: true });
    expect([...f.bankRows]).toEqual(prior);
    for (const o of f.originals) {
      expect(o.e.timeBankEngine.playerBanks.size).toBe(0);
      const receipt = f.receipts.get(o.m.tournamentId);
      expect(receipt.local_proof.engines[0].bank_custody.durable_presence).toEqual(
        f.bankRows.get(o.e.tableId)
      );
      expect(
        Object.values(
          receipt.local_proof.engines[0].bank_custody.durable_presence.time_bank_snapshot.players
        )[0]
      ).toMatchObject({ remainingSeconds: 75, usesRemaining: 2, unlimitedActivations: true });
    }
  });
  it.each(['missing', 'occupancy'])('refuses %s original bank evidence', async (fault) => {
    const f = await nativeCheckpoint(false, true),
      e = f.originals[0].e;
    if (fault === 'missing') f.bankRows.delete(e.tableId);
    else
      f.bankRows.get(e.tableId).time_bank_snapshot.players[e.seatedPlayers[0].user_id].occupancyId =
        id(999);
    expect(await f.run()).toMatchObject({ ok: false, restartAuthorized: false });
    expect(f.receipts.size).toBe(0);
    expect(f.s.tableEngines.size).toBe(2);
  });
  it('binds a cleared native accepted permit through its unchanged historical allocator epoch', async () => {
    const f = await nativeCheckpoint(true);
    expect(f.b.readyForRestart()).toBe(false);
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, readyForRestart: true });
    for (const o of f.originals) {
      const e = o.accepted.engine;
      expect(e.f06CurrentPermit).toBeNull();
      expect(e.f06AllocationEpoch).toBe(o.accepted.row.custody_id);
      expect([e.f06Allocator, e.f06AllocationCurrent, e.f06PermitFactory]).toEqual(
        o.accepted.allocation
      );
      expect(o.localMap.get(e.tableId)).toBe(e);
      expect(
        f.receipts
          .get(o.m.tournamentId)
          .local_proof.engines.find((v: any) => v.table_id === e.tableId)
      ).toMatchObject({ lifecycle: '1', allocation_epoch: e.f06AllocationEpoch, permit: null });
    }
    expect(f.s.tableEngines.size).toBe(0);
  });
  it.each([
    'missing-witness',
    'wrong-custody',
    'multiple-lifecycles',
    'late-epoch',
    'late-factory',
  ])('preserves all original objects when historical allocation proof has %s', async (fault) => {
    const f = await nativeCheckpoint(true);
    let changed = false;
    f.changeResponse((data) => {
      if (changed) return;
      changed = true;
      const witness = data.canonical.engine_lifecycles[0];
      if (fault === 'missing-witness') witness.permits = [];
      if (fault === 'wrong-custody') witness.permits[0].custody_id = id(999);
      if (fault === 'multiple-lifecycles')
        witness.permits.push({ ...witness.permits[0], permit_id: id(999), lifecycle: 2 });
      if (fault === 'late-epoch') f.originals[0].accepted.engine.f06AllocationEpoch = id(999);
      if (fault === 'late-factory')
        f.originals[0].accepted.engine.f06PermitFactory = () => f.originals[0].accepted.oldPermit;
    });
    expect(await f.run()).toMatchObject({ ok: false, restartAuthorized: false });
    expect(changed).toBe(true);
    expect(f.receipts.size).toBe(0);
    expect(f.s.tableEngines.size).toBe(4);
    expect(f.s.tournamentOwnedTables.size).toBe(4);
    for (const o of f.originals) {
      expect(o.e.f06CurrentPermit).toBe(o.permit);
      expect(o.permit.recoveryState()).toBe('reserved');
      expect(o.localMap.get(o.accepted.engine.tableId)).toBe(o.accepted.engine);
    }
  });
  it('opens native readiness only after both durable owners and native same-object CAS', async () => {
    const f = await nativeCheckpoint();
    expect(f.b.readyForRestart()).toBe(false);
    expect(f.b.snapshot().unparkedTables).toBe(2);
    f.onBoundary(() => {
      expect(f.b.readyForRestart()).toBe(false);
      expect(f.s.tableEngines.size).toBe(2);
    });
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      readyForRestart: true,
      restartAuthorized: false,
    });
    expect(f.receipts.size).toBe(2);
    expect(f.b.readyForRestart()).toBe(true);
    expect(f.s.tableEngines.size).toBe(0);
    expect(f.s.tournamentOwnedTables.size).toBe(0);
    for (const o of f.originals) {
      expect(o.m.tableEngines).toBe(o.localMap);
      expect(o.localMap.get(o.e.tableId)).toBe(o.e);
      expect(o.m.pendingTournamentSeatMoveOutcomes).toBe(o.pendingMap);
      expect([...o.pendingMap.values()]).toEqual([o.pending]);
      expect(o.e.f06CurrentPermit).toBe(o.permit);
      expect(o.permit.binding).toBe(o.binding);
      expect(o.permit.recoveryState()).toBe('reserved');
      expect(f.s.tournamentRetirementCustody.admissionAllowed(o.e.tableId)).toBe(false);
    }
  });
  it.each(['replacement', 'late-operation', 'same-value-new-identity', 'uncertain-receipt'])(
    'preserves old owners when %s arrives at durable receipt readback',
    async (cause) => {
      const f = await nativeCheckpoint();
      let changed = false;
      // The durable receipt readback is the find that FOLLOWS a commit. Since
      // 2026-09-25 the guard also asks the rows, per manager and before any
      // prepare, whether it already sealed that manager (#5240); that lookup is
      // a find too, and it is not the readback this models.
      let committed = false;
      f.onBoundary((name, args) => {
        if (name === 'fn_f06_prepare_mixed_manager_custody' && args.p_expected !== null)
          committed = true;
        if (changed || !committed || name !== 'fn_f06_find_mixed_manager_custody') return;
        changed = true;
        const o = f.originals[0];
        if (cause === 'replacement')
          f.s.tableEngines.set(o.e.tableId, Object.create(Object.getPrototypeOf(o.e)));
        if (cause === 'late-operation') o.e.tournamentMoveOperations.add(Promise.resolve());
        if (cause === 'same-value-new-identity')
          o.pendingMap.set([...o.pendingMap.keys()][0], structuredClone(o.pending));
        if (cause === 'uncertain-receipt') throw new Error('receipt committed, response lost');
      });
      expect(await f.run()).toMatchObject({
        ok: false,
        restartAuthorized: false,
        checkpointOutcome: 'unconfirmed',
      });
      expect(changed).toBe(true);
      expect(f.s.tableEngines.size).toBe(2);
      expect(f.s.tournamentOwnedTables.size).toBe(2);
      expect(f.receipts.size).toBe(1);
      for (const o of f.originals) {
        expect(o.localMap.get(o.e.tableId)).toBe(o.e);
        expect(o.permit.recoveryState()).toBe('reserved');
        expect(f.s.tournamentRetirementCustody.admissionAllowed(o.e.tableId)).toBe(false);
      }
      // Every manager is observed before any is committed (2026-09-24): both
      // observations, then the first commit, whose readback is where the
      // change arrives. The second manager is never committed.
      expect(
        checkpointIo.rpc.mock.calls
          .filter(([name]) => name === 'fn_f06_prepare_mixed_manager_custody')
          .map(([, args]) => (args.p_expected === null ? 'observe' : 'commit'))
      ).toEqual(['observe', 'observe', 'commit']);
    }
  );
});

describe('separate historical pending source requires complete native absence', () => {
  it('captures all 23 actual original engines and the separate absent pending source', async () => {
    const f = await nativeCheckpoint(false, false, true);
    expect(f.s.tableEngines.size).toBe(23);
    expect(await f.run()).toMatchObject({ ok: true, restartAuthorized: false });
    const noon = f.receipts.get(events8825[0]);
    expect(noon.local_proof.engines).toHaveLength(14);
    expect(noon.local_proof.historical_loss_pending_arrivals).toHaveLength(1);
    expect(noon.local_proof.historical_loss_pending_arrivals[0].absence.managers).toHaveLength(2);
  });
  it.each([
    'global',
    'manager',
    'diagnostic',
    'drained',
    'satellite',
    'retired-manager',
    'packet',
    'completed-packet',
    'no-start',
    'arrival',
    'unknown-map',
    'admission',
    'late-global',
  ])('refuses a present or unavailable pending source: %s', async (kind) => {
    const f = await nativeCheckpoint(false, false, true),
      owner = f.originals[0].m;
    const table = '66b1cb1d-5056-41c1-a951-1bd078f8276f';
    const e: any = new ServerTableEngine(table);
    const apply = () => {
      if (kind === 'global' || kind === 'late-global') f.s.tableEngines.set(table, e);
      if (kind === 'manager') owner.tableEngines.set(table, e);
      if (kind === 'diagnostic') owner.stoppedDiagnosticOriginals.set(table, e);
      if (kind === 'drained')
        owner.drainedF06Originals = [...owner.drainedF06Originals, [table, e]];
      if (kind === 'satellite') owner.satelliteQualifierEngines.set(table, e);
      if (kind === 'retired-manager') {
        const m: any = new manager.TournamentManager(
          id(1900),
          f.s,
          id(1901),
          performance.now() + 30000
        );
        m.tableEngines.set(table, e);
        f.s.tournamentDiagnosticRetirements.set(id(1900), new Set([m]));
      }
      const packet = { manager: owner, tournamentId: owner.tournamentId, engines: [[table, e]] };
      if (kind === 'packet') f.s.drainedF06TournamentCustody.set(owner.tournamentId, packet);
      if (kind === 'completed-packet')
        f.s.completedF06TournamentCustody.set(owner.tournamentId, new Set([{ original: packet }]));
      if (kind === 'no-start')
        owner.pendingNoStartContinuations.set(id(1991), { engine: e, binding: { tableId: table } });
      if (kind === 'arrival')
        owner.tournamentBreakArrivalWakes.set(id(1992), new Map([[id(1993), e]]));
      if (kind === 'unknown-map') f.s.tournamentDiagnosticRetirements = undefined;
      if (kind === 'admission') f.s.tableEngineStartPromises.set(table, Promise.resolve());
    };
    if (kind === 'late-global')
      f.onBoundary((name) => {
        if (name === 'fn_f06_prepare_mixed_manager_custody') apply();
      });
    else apply();
    expect(await f.run()).toMatchObject({ ok: false, restartAuthorized: false });
    expect(f.receipts.size).toBe(0);
    await e.stop();
  });
});

// The two original `mixed_original_work_not_drained` conjunctions refused with
// one opaque code for ~34 separate facts, and the engine's read-only
// diagnostics API exposes only a few of them, so a stuck release could not be
// diagnosed from outside. The refusal now carries the name of the exact
// sub-condition that failed. These cases pin BOTH halves of that contract: the
// added fields name the failing check, and `reason` stays byte-identical so
// every existing parser of `mixed_original_work_not_drained` is unaffected.
describe('the retained 8825 drain refusal names its failed sub-condition', () => {
  const drainCases: { check: string; observed: string; fault: (e: any) => void }[] = [
    { check: 'engine.terminal', observed: 'false', fault: (e) => (e.terminal = false) },
    {
      check: 'engine.terminalTeardownComplete',
      observed: 'false',
      fault: (e) => (e.terminalTeardownComplete = false),
    },
    {
      check: 'engine.dealingLoopPromise',
      observed: 'Promise',
      fault: (e) => (e.dealingLoopPromise = Promise.resolve()),
    },
    {
      check: 'engine.postHandTasksPromise',
      observed: 'Promise',
      fault: (e) => (e.postHandTasksPromise = Promise.resolve()),
    },
    {
      check: 'engine.snapshotFlushPromise',
      observed: 'Promise',
      fault: (e) => (e.snapshotFlushPromise = Promise.resolve()),
    },
    { check: 'engine.handController', observed: 'object', fault: (e) => (e.handController = {}) },
    { check: 'engine.actionLock', observed: 'true', fault: (e) => (e.actionLock = true) },
    {
      check: 'engine.f06HandPreparation',
      observed: 'Promise',
      fault: (e) => (e.f06HandPreparation = Promise.resolve()),
    },
    {
      check: 'engine.f06RecoveryInFlight',
      observed: 'true',
      fault: (e) => (e.f06RecoveryInFlight = true),
    },
    {
      check: 'engine.terminalBoundaryPersistenceFailed',
      observed: 'true',
      fault: (e) => (e.terminalBoundaryPersistenceFailed = true),
    },
    {
      check: 'engine.timeBankAccountingUnconfirmed',
      observed: 'true',
      fault: (e) => (e.timeBankAccountingUnconfirmed = true),
    },
    {
      check: 'engine.engineLeaseScope',
      observed: 'direct',
      fault: (e) => (e.engineLeaseScope = 'direct'),
    },
    {
      check: 'engine.engineLeaseVerified',
      observed: 'false',
      fault: (e) => (e.engineLeaseVerified = false),
    },
    {
      check: 'engine.engineLeaseTournamentId',
      observed: 'string(36)',
      fault: (e) => (e.engineLeaseTournamentId = id(999)),
    },
    {
      check: 'engine.engineLeaseGeneration',
      observed: 'string(36)',
      fault: (e) => (e.engineLeaseGeneration = id(998)),
    },
    {
      check: 'engine.hasOnlyDrainedTournamentMoveOwner(manager.tournamentMoveBoundaryOwner)',
      observed: 'false',
      fault: (e) => e.tournamentMovePauseOwners.add(id(997)),
    },
  ];
  it.each(drainCases)(
    'names $check and keeps the reason unchanged',
    async ({ check, observed, fault }) => {
      const f = await nativeCheckpoint(false, true);
      const e = f.originals[0].e;
      fault(e);
      const result: any = await f.run();
      // The pre-existing contract: same refusal, same code, nothing authorized.
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('mixed_original_work_not_drained');
      expect(result.restartAuthorized).toBe(false);
      expect(result.readyForRestart).toBe(false);
      expect(result.checkpointOutcome).toBe('not_started');
      // The new contract: the refusal names itself.
      expect(result.failedCheck).toBe(check);
      expect(result.failedTable).toBe(e.tableId);
      expect(result.observed).toBe(observed);
      expect(f.receipts.size).toBe(0);
      expect(f.s.tableEngines.size).toBe(2);
    }
  );

  it('names the live-engine registry clause without disturbing the registry', async () => {
    const f = await nativeCheckpoint(false, true);
    const e = f.originals[0].e;
    const live: Map<string, unknown> = (base.ServerTableEngineBase as any).liveEngines;
    live.set(e.tableId, e);
    try {
      const result: any = await f.run();
      expect(result.reason).toBe('mixed_original_work_not_drained');
      expect(result.failedCheck).toBe('base.liveEngines.has(tableId)');
      expect(result.observed).toBe('true');
      expect(result.failedTable).toBe(e.tableId);
    } finally {
      live.delete(e.tableId);
    }
  });

  it('names the move-owner clause the boolean predicate hides', async () => {
    const f = await nativeCheckpoint(false, true);
    const e = f.originals[0].e;
    // A pause claimed under a different owner is the deadlock this change was
    // written to expose: the native predicate returns one `false` for six
    // clauses, and only the claimed/paused owner sets can explain it.
    e.claimedTournamentMovePauseOwners.add(id(996));
    const result: any = await f.run();
    expect(result.reason).toBe('mixed_original_work_not_drained');
    expect(result.failedCheck).toBe(
      'engine.hasOnlyDrainedTournamentMoveOwner(manager.tournamentMoveBoundaryOwner)'
    );
    expect(result.observedDetail).toContain('terminalTeardownComplete=true');
    expect(result.observedDetail).toContain('notRunning=true');
    expect(result.observedDetail).toContain('tournamentMoveOperations=0');
    expect(result.observedDetail).toContain('tournamentMoveOperationByOwner=0');
    expect(result.observedDetail).toContain(
      'claimedTournamentMovePauseOwners=size=1/allMatchBoundaryOwner=false'
    );
    expect(result.observedDetail).toContain(
      'tournamentMovePauseOwners=size=0/allMatchBoundaryOwner=true'
    );
    // No owner value of any kind reaches the emitted detail.
    expect(result.observedDetail).not.toContain(id(996));
    expect(JSON.stringify(result)).not.toContain(id(996));
  });

  it('names which retained collection is not drained', async () => {
    const f = await nativeCheckpoint(false, true);
    const e = f.originals[0].e;
    e.readContinuationTasks.add(Promise.resolve());
    const result: any = await f.run();
    expect(result.reason).toBe('mixed_original_work_not_drained');
    expect(result.failedCheck).toBe('engineCollection.size');
    expect(result.failedField).toBe('readContinuationTasks');
    expect(result.failedTable).toBe(e.tableId);
    expect(result.observed).toBe('1');
    expect(result.expected).toBe('0');
  });

  it('names which retained collection has the wrong type', async () => {
    const f = await nativeCheckpoint(false, true);
    const e = f.originals[0].e;
    e.timeBankAccountingPending = new Map();
    const result: any = await f.run();
    expect(result.reason).toBe('mixed_original_work_not_drained');
    expect(result.failedCheck).toBe('engineCollection.type');
    expect(result.failedField).toBe('timeBankAccountingPending');
    expect(result.observed).toBe('Map(0)');
    expect(result.expected).toBe('Set');
  });

  it('adds no field when the checkpoint qualifies', async () => {
    const f = await nativeCheckpoint(false, true);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, reason: null });
    for (const key of ['failedCheck', 'failedTable', 'failedField', 'observed', 'expected'])
      expect(result[key]).toBeUndefined();
  });

  it('adds no field to a refusal raised by a different check', async () => {
    const f = await nativeCheckpoint(false, true);
    const e = f.originals[0].e;
    // `mixed_bank_shape` is the require that follows the two split sites; it is
    // untouched by this change and must still refuse with no added detail.
    e.handCount = -1;
    const result: any = await f.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mixed_bank_shape');
    for (const key of ['failedCheck', 'failedTable', 'failedField', 'observed', 'expected'])
      expect(result[key]).toBeUndefined();
  });
});
