import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { MaintenanceBreak } from '../maintenance/MaintenanceBreak.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { prepareF06SuccessorAdmission } from './drainedF06Custody.js';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  resume: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  from: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase/handHistory.js', async (original) => ({
  ...(await original<any>()),
  resumeRetainedHandSubmission: mocks.resume,
}));
vi.mock('../services/tournamentLease.js', async (original) => ({
  ...(await original<any>()),
  claimTournamentLease: mocks.claim,
  releaseTournaments: mocks.release,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const managers: any[] = [];
const gate = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { promise, resolve };
};
function response(args: any, pending = [id(4)], terminal: unknown[] = []) {
  return {
    error: null,
    data: {
      ok: true,
      tournament_id: args.p_tournament_id,
      lease_generation: args.p_lease_generation,
      recovery_required: pending.length > 0,
      pending_tables: pending,
      proof: args.p_expected ?? { parks: [], originals: [] },
      terminal_proof: terminal,
    },
  };
}
function server(): any {
  const s = Object.create(GameServer.prototype);
  Object.assign(s, {
    running: true,
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
    drainedF06TournamentCustody: new Map(),
    completedF06TournamentCustody: new Map(),
    tournamentManagerRetirementOperations: new WeakMap(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
    tournamentManagerAdmissionLeaseGenerations: new Map(),
    tournamentManagerAdmissionOperations: new Map(),
    tournamentTopUpsInFlight: new Map(),
    tournamentManagerAdmissionRetryTimers: new Map(),
    discoveryJobs: new Set(),
    directAdmissionIsCurrent: () => true,
    clearTournamentManagerAdmissionRetry: vi.fn(),
    scheduleTournamentManagerAdmissionRetry: vi.fn(),
    finishTournamentManagerAdmission: vi.fn(),
  });
  return s;
}
function manager(s = server()): any {
  const m = new TournamentManager(id(1), s, id(2), performance.now() + 30_000);
  managers.push(m);
  return m;
}
beforeEach(() => {
  mocks.from
    .mockReset()
    .mockReturnValue({ select: () => ({ in: async () => ({ data: [], error: null }) }) });
  mocks.rpc.mockReset().mockImplementation(async (_n, a) => response(a));
  mocks.resume.mockReset().mockResolvedValue(null);
  mocks.claim.mockReset().mockResolvedValue({
    status: 'granted',
    leaseGeneration: id(9),
    proofDeadlineMonotonicMs: performance.now() + 30_000,
  });
  mocks.release.mockReset().mockResolvedValue({ status: 'confirmed', attempts: 1 });
});
afterEach(() => {
  for (const m of managers.splice(0)) m.fenceForTournamentLeaseLoss();
  vi.restoreAllMocks();
});
function mixedResponse(name: string, a: any) {
  if (name === 'fn_f06_find_mixed_manager_custody')
    return { error: null, data: { ok: true, tournament_id: a.p_tournament_id, receipt: null } };
  if (name === 'fn_f06_admit_mixed_manager_custody')
    return {
      error: null,
      data: {
        ok: true,
        transfer_id: a.p_transfer_id,
        tournament_id: a.p_tournament_id,
        lease_generation: a.p_lease_generation,
        custody_only: true,
        receipt: a.p_expected,
        admission: {
          transfer_id: a.p_transfer_id,
          generation: a.p_lease_generation,
          terminal_proof: a.p_expected.local_proof.engines
            .filter((e: any) => e.permit)
            .map((e: any) => ({
              binding: e.permit.binding,
              evidence: { original_receipt: id(77) },
            })),
        },
      },
    };
  const canonical = a.p_expected ?? {
    operations: [{ break_id: id(5), source_table_id: id(3), lifecycle: '1', state: 'begun' }],
    tables: [{ id: id(3) }, { id: id(4) }],
    attempts: [id(12)],
    originals: [id(13)],
    pending_original_tables: [id(4)],
    no_start_continuations: [],
  };
  return {
    error: null,
    data: {
      ok: true,
      transfer_id: a.p_transfer_id,
      tournament_id: a.p_tournament_id,
      origin_generation: a.p_origin_generation,
      successor_generation: a.p_successor_generation,
      local: a.p_local,
      canonical,
      receipt: a.p_expected
        ? {
            transfer_id: a.p_transfer_id,
            tournament_id: a.p_tournament_id,
            origin_generation: a.p_origin_generation,
            successor_generation: a.p_successor_generation,
            local_proof: a.p_local,
            canonical_proof: canonical,
            created_at: '2026-09-18T23:00:00.000Z',
          }
        : null,
    },
  };
}
async function mixedStopped() {
  const s = server(),
    m = manager(s);
  const engines = [id(3), id(4)].map((table) => {
    const engine = new ServerTableEngine(table, {
      scope: 'tournament',
      verified: true,
      tournamentId: id(1),
      generation: id(2),
      proofDeadlineMonotonicMs: performance.now() + 30_000,
    });
    engine.installF06Allocator(
      id(15),
      async () => 1,
      () => true,
      '1'
    );
    return [table, engine] as const;
  });
  const permit = new F06HandPermit(
    {
      tournament_id: id(1),
      lease_generation: id(2),
      table_id: id(4),
      lifecycle: '1',
      permit_id: id(13),
      hand_number: '2',
      custody_id: id(14),
    },
    async () => ({ data: null, error: { message: 'unknown original begin' } }),
    () => true
  );
  await expect(permit.reserve()).rejects.toThrow();
  (engines[1][1] as any).f06CurrentPermit = permit;
  m.tableEngines = new Map(engines);
  s.tableEngines = new Map(engines);
  s.tournamentOwnedTables = new Set(engines.map(([table]) => table));
  s.tournamentEngines.set(id(1), m);
  m.retainedTournamentBreakSources.set(id(3), { breakId: id(5), engine: engines[0][1] });
  m.durableTournamentBreaks.set(id(5), {
    lifecycle: '1',
    state: 'begun',
    revision: '1',
    members: [],
    custody_id: id(6),
    custody_generation: id(2),
    terminal_handoff_required: false,
  });
  m.pendingTournamentSeatMoveOutcomes.set(id(12), {
    move: { fromTableId: id(3), toTableId: id(4) },
    input: {
      requestId: id(12),
      tournamentId: id(1),
      userId: id(11),
      sourceTableId: id(3),
      destinationTableId: id(4),
      destinationSeatNumber: 1,
      sourceMode: 'live_source',
    },
  });
  vi.spyOn(m, 'resolveTournamentSeatMoveQuarantine').mockResolvedValue(false);
  m.fenceForTournamentLeaseLoss();
  await expect(m.stop()).rejects.toThrow('failed to stop');
  expect(m.captureDrainedF06Originals()).toHaveLength(2);

  mocks.rpc.mockImplementation(async (name, a) => mixedResponse(name, a));
  mocks.claim.mockImplementation(async (_id, generation) => ({
    status: 'granted',
    leaseGeneration: generation,
    proofDeadlineMonotonicMs: performance.now() + 30_000,
  }));
  return { s, m, engines, permit };
}
it('transfers real stopped originals only after a receipt and keeps preparation visible', async () => {
  const { s, m, engines, permit } = await mixedStopped();
  mocks.release.mockImplementation(async () => {
    expect(s.drainedF06TournamentCustody.get(id(1)).mixed.receipt).toBeTruthy();
    expect(s.tournamentEngines.has(id(1))).toBe(false);
    expect([...s.enginesIncludingMixedF06Custody()].map(([, e]: any) => e)).toEqual(
      engines.map(([, e]) => e)
    );
    return { status: 'confirmed', attempts: 1 };
  });
  expect(await s.stopTournamentManagerIfOwned(id(1), m, 'mixed')).toBe(true);
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(m.pendingTournamentSeatMoveOutcomes.has(id(12))).toBe(true);
  expect((engines[1][1] as any).f06CurrentPermit).toBe(permit);
  expect(await s.drainHands(0)).toEqual({ drained: 1, total: 2, timedOut: true });
  const resume = vi.spyOn(TournamentManager.prototype, 'resume');
  await s.performTournamentManagerAdmission(id(1), 'resume', 'mixed', 1);
  const successor = s.tournamentEngines.get(id(1));
  managers.push(successor);
  expect(successor.isF06RecoveryOwner()).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(s.drainedF06TournamentCustody.get(id(1)).mixed.successorGeneration).toBe(
    successor.getTournamentLeaseGeneration()
  );
});
it.each([
  'readContinuationTasks',
  'settlementInFlight',
  'tournamentMoveOperations',
  'timeBankAccountingPending',
  'terminalBoundaryPendingGenerations',
])('refuses retained %s', async (field) => {
  const { s, m, engines } = await mixedStopped();
  (engines[0][1] as any)[field].add(Promise.resolve());
  expect(await s.transferDrainedF06Custody(id(1), m)).toBe(false);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(s.tournamentEngines.get(id(1))).toBe(m);
  (engines[0][1] as any)[field].clear();
});
it.each(['f06HandPreparation', 'snapshotFlushPromise', 'postHandTasksPromise'])(
  'refuses unfinished %s',
  async (field) => {
    const { s, m, engines } = await mixedStopped();
    (engines[0][1] as any)[field] = {};
    expect(await s.transferDrainedF06Custody(id(1), m)).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    (engines[0][1] as any)[field] = null;
  }
);
it('retains the same transfer and exact request after a lost durable reply', async () => {
  const { s, m } = await mixedStopped();
  let original: any;
  mocks.rpc.mockImplementation(async (name, a) => {
    if (a.p_expected) {
      original = a;
      throw new Error('reply lost');
    }
    return mixedResponse(name, a);
  });
  await expect(s.stopTournamentManagerIfOwned(id(1), m, 'mixed')).rejects.toThrow('reply lost');
  expect(mocks.release).not.toHaveBeenCalled();
  expect(s.tournamentEngines.get(id(1))).toBe(m);
  mocks.rpc.mockImplementation(async (name, a) => {
    expect(a).toEqual(original);
    return mixedResponse(name, a);
  });
  expect(await s.transferDrainedF06Custody(id(1), m)).toBe(true);
  expect(mocks.rpc.mock.calls.slice(1).map(([, a]) => a.p_transfer_id)).toEqual([
    original.p_transfer_id,
    original.p_transfer_id,
  ]);
  expect(m.pendingTournamentSeatMoveOutcomes.has(id(12))).toBe(true);
});
it('refuses release when a global object changes after receipt commit', async () => {
  const { s, m, engines } = await mixedStopped();
  mocks.rpc.mockImplementation(async (name, a) => {
    const r = mixedResponse(name, a);
    if (a.p_expected)
      s.tableEngines.set(
        id(3),
        new ServerTableEngine(id(3), {
          scope: 'tournament',
          verified: true,
          tournamentId: id(1),
          generation: id(2),
          proofDeadlineMonotonicMs: performance.now() + 30_000,
        })
      );
    return r;
  });
  await expect(s.stopTournamentManagerIfOwned(id(1), m, 'mixed')).rejects.toThrow('unproven');
  expect(s.tournamentEngines.get(id(1))).toBe(m);
  expect(m.tableEngines.get(id(3))).toBe(engines[0][1]);
  expect(mocks.release).not.toHaveBeenCalled();
});
it('retains an unknown ACK and its exact inactive reservation', async () => {
  const { s, m, engines } = await mixedStopped();
  const binding = {
    tournamentId: id(1),
    breakId: id(5),
    tableId: id(3),
    tableIncarnation: '1',
    leaseGeneration: id(2),
    custodyId: id(6),
    durableRevision: '1',
  };
  await expect(
    s.tournamentRetirementCustody.withCustody(
      binding,
      s.tableEngines,
      m.tableEngines,
      () => true,
      async () => {
        throw new Error('ACK reply lost');
      },
      async () => {}
    )
  ).rejects.toThrow('ACK reply lost');
  expect(await s.transferDrainedF06Custody(id(1), m)).toBe(true);
  expect(s.tournamentRetirementCustody.admissionAllowed(id(3))).toBe(false);
  expect(s.drainedF06TournamentCustody.get(id(1)).mixed.local.reservations[0].binding).toEqual([
    id(1),
    id(5),
    id(3),
    '1',
    id(2),
    id(6),
    '1',
  ]);
  expect(m.tableEngines.get(id(3))).toBe(engines[0][1]);
});
it('unknown old-lease release retains receipt custody and selected successor', async () => {
  const { s, m } = await mixedStopped();
  mocks.release.mockResolvedValue({
    status: 'unknown',
    reason: 'reply lost',
    attempts: 1,
    detail: 'unknown',
  });
  await expect(s.stopTournamentManagerIfOwned(id(1), m, 'mixed')).rejects.toThrow('not confirmed');
  const packet = s.drainedF06TournamentCustody.get(id(1));
  expect(packet.mixed.receipt).toBeTruthy();
  expect(s.tournamentManagerPendingLeaseReleases.get(id(1))).toBe(id(2));
  expect(s.tournamentManagerAdmissionLeaseGenerations.get(id(1))).toBe(
    packet.mixed.successorGeneration
  );
  expect([...s.enginesIncludingMixedF06Custody()]).toHaveLength(2);
});
it('process replacement retains source recovery gate after terminal hand adoption', async () => {
  const { s, m } = await mixedStopped();
  await s.transferDrainedF06Custody(id(1), m);
  const transfer = s.drainedF06TournamentCustody.get(id(1)).mixed;
  const replacement = server();
  mocks.rpc.mockImplementation(async (name, a) =>
    name === 'fn_f06_find_mixed_manager_custody'
      ? { error: null, data: { ok: true, tournament_id: id(1), receipt: transfer.receipt } }
      : mixedResponse(name, a)
  );
  const resume = vi.spyOn(TournamentManager.prototype, 'resume');
  await replacement.performTournamentManagerAdmission(id(1), 'resume', 'replacement', 1);
  expect(mocks.claim).toHaveBeenLastCalledWith(id(1), transfer.successorGeneration);
  const owner = replacement.tournamentEngines.get(id(1));
  managers.push(owner);
  expect(owner.isF06RecoveryOwner()).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  expect(await replacement.drainHands(0)).toEqual({ drained: 0, total: 1, timedOut: true });
  const maintenance = new MaintenanceBreak({
    engines: () => [],
    retainedPreparationBlockers: () => replacement.mixedF06PreparationBlockers(),
  } as never) as any;
  Object.assign(maintenance, {
    phase: 'counting_down',
    peakUnparked: 0,
  });
  expect(maintenance.unparkedTables()).toEqual([id(3)]);
  expect(maintenance.unparkedReasonCounts).toEqual({ f06_preparation_unresolved: 1 });
});
it('missing receipt discovery is unknown and never starts a claim', async () => {
  const replacement = server();
  mocks.rpc.mockResolvedValue({ error: { message: 'unavailable' }, data: null });
  await expect(
    replacement.performTournamentManagerAdmission(id(1), 'resume', 'replacement', 1)
  ).rejects.toThrow('discovery_unproven');
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('foreign preselected generation refuses before claim', async () => {
  const { s, m } = await mixedStopped();
  await s.transferDrainedF06Custody(id(1), m);
  s.tournamentManagerAdmissionLeaseGenerations.set(id(1), id(99));
  await expect(
    s.performTournamentManagerAdmission(id(1), 'resume', 'replacement', 1)
  ).rejects.toThrow('generation_changed');
  expect(mocks.claim).not.toHaveBeenCalled();
});

for (const gap of [
  'extra-global',
  'missing-global',
  'missing-local',
  'missing-accessor',
  'stale-lifecycle',
  'active-reservation',
  'orphan-reservation',
] as const) {
  it(`refuses incomplete custody before RPC: ${gap}`, async () => {
    const { s, m, engines } = await mixedStopped();
    if (gap === 'extra-global')
      s.tableEngines.set(
        id(20),
        new ServerTableEngine(id(20), {
          scope: 'tournament',
          verified: true,
          tournamentId: id(1),
          generation: id(2),
          proofDeadlineMonotonicMs: performance.now() + 30_000,
        })
      );
    if (gap === 'missing-global') s.tableEngines.delete(id(3));
    if (gap === 'missing-local') m.tableEngines.delete(id(3));
    if (gap === 'missing-accessor') (engines[0][1] as any).captureDrainedF06Identity = undefined;
    if (gap === 'stale-lifecycle') (engines[0][1] as any).f06TableLifecycle = '';
    if (gap === 'active-reservation') {
      (s.tournamentRetirementCustody as any).held.set(id(3), '1');
      (s.tournamentRetirementCustody as any).pending.set(
        id(3),
        JSON.stringify([id(1), id(5), id(3), '1', id(2), id(6), '1'])
      );
      (s.tournamentRetirementCustody as any).active.add(id(3));
    }
    if (gap === 'orphan-reservation') (s.tournamentRetirementCustody as any).held.set(id(3), '1');
    expect(await s.transferDrainedF06Custody(id(1), m)).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(s.tournamentEngines.get(id(1))).toBe(m);
  });
}
it('keeps a pending UUID changed during observation attached to its original owner', async () => {
  const { s, m } = await mixedStopped();
  mocks.rpc.mockImplementation(async (name, a) => {
    const r = mixedResponse(name, a);
    m.pendingTournamentSeatMoveOutcomes.delete(id(12));
    return r;
  });
  await expect(s.transferDrainedF06Custody(id(1), m)).rejects.toThrow('unproven');
  expect(mocks.rpc).toHaveBeenCalledOnce();
  expect(s.tournamentEngines.get(id(1))).toBe(m);
  expect(mocks.release).not.toHaveBeenCalled();
});
it('freezes detached nested local and canonical proof before durable capture', async () => {
  const { s, m } = await mixedStopped();
  expect(await s.transferDrainedF06Custody(id(1), m)).toBe(true);
  const t = s.drainedF06TournamentCustody.get(id(1)).mixed;
  expect(Object.isFrozen(t.local.pending_moves[0][1].input)).toBe(true);
  expect(Object.isFrozen(t.canonical.operations[0])).toBe(true);
  expect(() => {
    t.local.pending_moves[0][1].input.requestId = id(30);
  }).toThrow();
  expect(m.pendingTournamentSeatMoveOutcomes.get(id(12)).input.requestId).toBe(id(12));
});

/** Transport is modeled; real manager, guards, RPC parsers and replay execute. */
async function recoverableMixedScene(interrupt?: string, absentSource = false) {
  let { s, m, engines, permit } = await mixedStopped();
  const inputs = [11, 21].map((user, i) => ({
    user_id: id(user),
    source_seat_id: id(user + 20),
    source_seat_number: i + 1,
    occupancy_id: id(user + 30),
    request_id: id(user + 1),
    destination_table_id: id(4),
    destination_seat_number: i + 1,
  }));
  m.pendingTournamentParkRequests.set(id(3), {
    breakId: id(5),
    lifecycle: '1',
    boundaryId: id(25),
  });
  m.pendingTournamentBreakBegins.set(id(5), inputs);
  m.pendingTournamentBreakAmendments.set(`${id(5)}:${id(21)}:${id(22)}`, {
    breakId: id(5),
    userId: id(21),
    expectedRequestId: id(22),
    amendmentId: id(23),
    newRequestId: id(24),
    destinationTableId: id(4),
    destinationSeatNumber: 2,
    reason: 'original capacity refusal',
  });
  m.pendingTournamentBreakCustodyIds.set(id(5), id(6));
  m.pendingTournamentCleanupKinds.set(id(5), 'retired');
  for (const [i, request] of [id(12), id(24)].entries())
    m.pendingTournamentSeatMoveOutcomes.set(request, {
      input: {
        requestId: request,
        tournamentId: id(1),
        userId: inputs[i].user_id,
        sourceTableId: id(3),
        destinationTableId: id(4),
        destinationSeatNumber: i + 1,
        sourceMode: 'live_source',
      },
      move: {
        playerId: inputs[i].user_id,
        fromTableId: id(3),
        fromSeat: i + 1,
        toTableId: id(4),
        toSeat: i + 1,
        reason: 'table_break',
      },
    });
  await s.transferDrainedF06Custody(id(1), m);
  let transfer = s.drainedF06TournamentCustody.get(id(1)).mixed;
  if (absentSource) {
    transfer = structuredClone(transfer);
    const original = { table_id: id(3), break_id: id(5), lifecycle: '1' };
    transfer.local.retained = [];
    transfer.local.historical_loss_pending_arrivals = [
      {
        original,
        absence: {
          table_id: id(3),
          global_absent: true,
          owned_absent: true,
          retirement_absent: true,
        },
      },
    ];
    transfer.canonical.operations[0] = {
      ...transfer.canonical.operations[0],
      tournament_id: id(1),
      source_table_id: id(3),
      lifecycle: '1',
    };
    transfer.canonical.historical_loss = {
      kind: 'historical_loss_normal_session_v1',
      pending_arrivals: [
        {
          source: { table_id: id(3) },
          proof: {
            historical_loss: {
              original_kind: 'pending_arrival_historical_loss_v1',
              observations: [{ original }],
            },
          },
        },
      ],
    };
    transfer.receipt.local_proof = transfer.local;
    transfer.receipt.canonical_proof = transfer.canonical;
    s = server();
  }
  const winners = new Map<string, any>(),
    intents = new Map<string, unknown>(),
    calls: Array<{ name: string; args: any }> = [];
  let stage = 'begun',
    revision = '1',
    custodyGeneration = id(2),
    complete = false;
  const state = () => ({
    ok: true,
    reason: null,
    tournament_id: id(1),
    break_id: id(5),
    source_table_id: id(3),
    lifecycle: '1',
    state: stage,
    revision,
    custody_id: id(6),
    custody_generation: custodyGeneration,
    terminal_handoff_required: false,
    members: inputs.map((input, i) => {
      const request = i === 0 ? id(12) : id(24);
      return {
        ...input,
        original_destination_table_id: id(4),
        original_destination_seat_number: i + 1,
        winning_receipt: winners.get(request) ?? null,
        active_request_id: winners.has(request) ? null : request,
        winner_request_id: winners.has(request) ? request : null,
        attempt_revision: i + 1,
      };
    }),
  });
  mocks.rpc.mockImplementation(async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === interrupt) throw new Error(`interrupted ${name}`);
    const ok = (data: unknown) => ({ error: null, data });
    if (name === 'fn_f06_find_mixed_manager_custody')
      return ok({ ok: true, tournament_id: id(1), receipt: complete ? null : transfer.receipt });
    if (name === 'fn_f06_admit_mixed_manager_custody') return mixedResponse(name, args);
    if (name === 'fn_f06_mixed_custody_intent') {
      if (intents.has(args.p_key)) expect(intents.get(args.p_key)).toEqual(args.p_payload);
      intents.set(args.p_key, structuredClone(args.p_payload));
      return ok({
        ok: true,
        transfer_id: transfer.transferId,
        key: args.p_key,
        payload: args.p_payload,
      });
    }
    if (name === 'fn_move_tournament_player') {
      const i = args.p_request_id === id(12) ? 0 : 1;
      expect(args.p_request_id).toBe(i === 0 ? id(12) : id(24));
      const receipt = {
        request_id: args.p_request_id,
        tournament_id: id(1),
        user_id: inputs[i].user_id,
        source_table_id: id(3),
        destination_table_id: id(4),
        source_seat_id: inputs[i].source_seat_id,
        destination_seat_id: id(50 + i),
        source_seat_number: i + 1,
        destination_seat_number: i + 1,
        stack: 100,
        source_mode: 'live_source',
        moved_at: '2026-09-18T23:59:00Z',
        source_occupancy_id: inputs[i].occupancy_id,
        source_lifecycle: '1',
        break_id: id(5),
      };
      const replayed = winners.has(args.p_request_id);
      winners.set(args.p_request_id, receipt);
      if (!replayed && i === 0) throw new Error('first original move committed; reply lost');
      return ok({ ...receipt, ok: true, replayed });
    }
    if (name === 'fn_f06_begin_break') {
      expect(intents.get(`begin:${id(5)}`)).toEqual(inputs);
      expect(args.p_members).toEqual(inputs);
    } else if (name === 'fn_f06_amend_attempt') {
      expect(args.p_amendment_id).toBe(id(23));
      expect(args.p_expected_request_id).toBe(id(22));
      expect(args.p_new_request_id).toBe(id(24));
    } else if (name === 'fn_f06_claim_custody') {
      expect(winners.size).toBe(2);
      expect(intents.get(`custody:${id(5)}`)).toEqual({ custodyId: id(6) });
      expect(args.p_custody_id).toBe(id(6));
      custodyGeneration = transfer.successorGeneration;
      revision = '2';
    } else if (name === 'fn_f06_close_break') stage = 'close_confirmed';
    else if (name === 'fn_f06_ack_cleanup') {
      expect(args.p_cleanup_kind).toBe('retired');
      expect(args.p_custody_id).toBe(id(6));
      expect(args.p_revision).toBe('2');
      stage = 'acknowledged';
    } else if (name === 'fn_f06_complete_mixed_manager_custody') {
      expect(stage).toBe('acknowledged');
      complete = true;
      return ok({
        ok: true,
        transfer_id: transfer.transferId,
        tournament_id: id(1),
        lease_generation: transfer.successorGeneration,
        completion: {
          transfer_id: transfer.transferId,
          generation: transfer.successorGeneration,
          operation_receipts: [state()],
          presence_receipts: [],
        },
      });
    } else if (name === 'fn_f06_assert_drained_manager_custody') return response(args, [], []);
    else if (!['fn_f06_request_park', 'fn_f06_break_state'].includes(name))
      throw new Error(`unexpected recovery RPC ${name}`);
    return ok(state());
  });
  const resume = vi.spyOn(TournamentManager.prototype, 'resume').mockResolvedValue();
  await s.performTournamentManagerAdmission(id(1), 'resume', 'qualified mixed', 1);
  const successor = s.tournamentEngines.get(id(1));
  if (successor) managers.push(successor);
  return {
    s,
    m,
    successor,
    transfer,
    calls,
    winners,
    resume,
    engines,
    permit,
    unblock: () => {
      interrupt = undefined;
    },
  };
}
it('real successor consumes original park begin amendment moves custody and ACK before ordinary restart', async () => {
  const { s, m, successor, transfer, calls, winners, resume, engines, permit } =
    await recoverableMixedScene();
  expect(winners.size).toBe(2);
  expect(
    calls.filter((c) => c.name === 'fn_move_tournament_player').map((c) => c.args.p_request_id)
  ).toEqual([id(12), id(12), id(24)]);
  expect(calls.find((c) => c.name === 'fn_f06_request_park')?.args.p_boundary_id).toBe(id(25));
  expect(successor.isF06RecoveryOwner()).toBe(false);
  for (const field of [
    'pendingTournamentParkRequests',
    'pendingTournamentBreakBegins',
    'pendingTournamentBreakAmendments',
    'pendingTournamentSeatMoveOutcomes',
    'pendingTournamentBreakCustodyIds',
    'pendingTournamentCleanupKinds',
  ])
    expect(successor[field].size).toBe(0);
  expect(m.pendingTournamentSeatMoveOutcomes.size).toBe(2);
  expect((engines[1][1] as any).f06CurrentPermit).toBe(permit);
  expect(s.drainedF06TournamentCustody.has(id(1))).toBe(false);
  expect(s.durableMixedF06Custody.has(id(1))).toBe(false);
  expect(s.mixedF06PreparationBlockers()).toEqual([]);
  expect(resume).toHaveBeenCalledOnce();
  const next = server();
  await next.performTournamentManagerAdmission(id(1), 'resume', 'ordinary later restart', 1);
  const ordinary = next.tournamentEngines.get(id(1));
  managers.push(ordinary);
  expect(ordinary.isF06RecoveryOwner()).toBe(false);
  expect(ordinary.getTournamentLeaseGeneration()).not.toBe(transfer.successorGeneration);
  expect(resume).toHaveBeenCalledTimes(2);
});
it.each([
  'fn_f06_mixed_custody_intent',
  'fn_f06_begin_break',
  'fn_f06_amend_attempt',
  'fn_f06_claim_custody',
  'fn_f06_close_break',
  'fn_f06_ack_cleanup',
  'fn_f06_complete_mixed_manager_custody',
])('interrupted %s retains exact custody and prevents ordinary dealing', async (rpc) => {
  const { s, successor, resume, transfer } = await recoverableMixedScene(rpc);
  expect(successor.isF06RecoveryOwner()).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  expect(s.drainedF06TournamentCustody.get(id(1)).mixed).toBe(transfer);
  expect(s.tournamentRetirementCustody.admissionAllowed(id(3))).toBe(false);
  expect(s.mixedF06PreparationBlockers()).toEqual([id(3)]);
});

it.each([
  'fn_f06_mixed_custody_intent',
  'fn_f06_begin_break',
  'fn_f06_amend_attempt',
  'fn_f06_claim_custody',
  'fn_f06_close_break',
  'fn_f06_ack_cleanup',
  'fn_f06_complete_mixed_manager_custody',
])('the original admission continues after %s without replacing its owner', async (rpc) => {
  const { s, successor, transfer, winners, resume, unblock, calls } =
    await recoverableMixedScene(rpc);
  unblock();
  const first = s.ensureTournamentManagerAdmission(id(1), 'resume', 'original continuation', 1);
  const second = s.ensureTournamentManagerAdmission(
    id(1),
    'resume',
    'same original continuation',
    1
  );
  expect(second).toBe(first);
  await first;
  expect(s.tournamentEngines.get(id(1))).toBe(successor);
  expect(successor.isF06RecoveryOwner()).toBe(false);
  expect(winners.size).toBe(2);
  expect(mocks.claim).toHaveBeenCalledOnce();
  expect(mocks.release).not.toHaveBeenCalled();
  expect(resume).toHaveBeenCalledOnce();
  expect(s.mixedF06PreparationBlockers()).toEqual([]);
  expect(s.terminalMixedF06Admissions.has(transfer.transferId)).toBe(false);
  expect(
    new Set(
      calls.filter((c) => c.name === 'fn_move_tournament_player').map((c) => c.args.p_request_id)
    )
  ).toEqual(new Set([id(12), id(24)]));
  expect(s.scheduleTournamentManagerAdmissionRetry).not.toHaveBeenCalled();
});
it('a durable manager wake continues retained admission before requesting or acknowledging its sweep', async () => {
  const { s, successor, resume, unblock } = await recoverableMixedScene('fn_f06_ack_cleanup');
  const sweep = vi.spyOn(successor, 'requestEliminationSweep').mockReturnValue(true);
  vi.spyOn(successor, 'isRunning').mockImplementation(() => !successor.isF06RecoveryOwner());
  const wake = {
    id: 7,
    generation: 2,
    tournament_id: id(1),
    consumed_at: null,
    reason: 'player_action',
  };
  expect(await s.admitTournamentManagerWake(wake)).toBe(false);
  expect(sweep).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  unblock();
  expect(await s.admitTournamentManagerWake(wake)).toBe(true);
  expect(resume).toHaveBeenCalledOnce();
  expect(sweep).toHaveBeenCalledWith('player_action', 7, 2);
});

it.each(['shutdown', 'replacement'])(
  'a %s never resumes an old mixed admission',
  async (change) => {
    const { s, successor, unblock, calls, resume } =
      await recoverableMixedScene('fn_f06_ack_cleanup');
    unblock();
    if (change === 'shutdown') s.directAdmissionIsCurrent = () => false;
    else s.tournamentEngines.set(id(1), { isF06RecoveryOwner: () => true });
    const before = calls.length;
    await s.ensureTournamentManagerAdmission(id(1), 'resume', 'stale continuation', 1);
    expect(calls.length).toBe(before);
    expect(successor.isF06RecoveryOwner()).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  }
);

it('a normal resume failure after completed recovery enters exact-owner cleanup', async () => {
  const { s, successor, unblock, resume } = await recoverableMixedScene('fn_f06_ack_cleanup');
  unblock();
  resume.mockRejectedValueOnce(new Error('ordinary resume failed'));
  const stop = vi.spyOn(s, 'stopTournamentManagerIfOwned').mockResolvedValue(true);
  await expect(
    s.ensureTournamentManagerAdmission(id(1), 'resume', 'original continuation', 1)
  ).rejects.toThrow('ordinary resume failed');
  expect(stop).toHaveBeenCalledWith(
    id(1),
    successor,
    'GameServer.mixed_completed_admission_cleanup_failed'
  );
  expect(successor.isF06RecoveryOwner()).toBe(false);
  expect(s.mixedF06AdmissionContinuations.has(id(1))).toBe(false);
});

it.each(['confirmed', 'lost-reply'])(
  'hands bank-only custody to the selected successor after %s preparation',
  async (outcome) => {
    const s = server(),
      m = manager(s);
    const engine: any = new ServerTableEngine(id(3), {
      scope: 'tournament',
      verified: true,
      tournamentId: id(1),
      generation: id(2),
      proofDeadlineMonotonicMs: performance.now() + 30_000,
    });
    engine.installF06Allocator(
      id(15),
      async () => 1,
      () => true,
      '1'
    );
    engine.tableInfo = { tournament_id: id(1) };
    engine.handCount = 12;
    engine.seatedPlayers = [{ user_id: id(11), occupancy_id: id(31), seat_number: 1, stack: 1500 }];
    engine.timeBankEngine.initializePlayer(id(3), id(11), {
      remainingSeconds: 7,
      usesRemaining: 1,
      unlimitedActivations: true,
    });
    engine.timeBankMeta.set(id(11), {
      initialSeconds: 80,
      baseSeconds: 40,
      dbConsumedSeconds: 33,
      unlimitedActivations: true,
    });
    m.tableEngines.set(id(3), engine);
    s.tableEngines.set(id(3), engine);
    s.tournamentOwnedTables.add(id(3));
    s.tournamentEngines.set(id(1), m);
    m.fenceForTournamentLeaseLoss();
    let transfer: any,
      nativeRow: any,
      savedReceipt: any,
      lost = false;
    mocks.rpc.mockImplementation(async (name, a) => {
      if (name === 'fn_f06_prepare_mixed_manager_custody') {
        expect(a.p_local.retained).toEqual([]);
        const capture = a.p_local.engines[0].bank_custody.stopped_capture;
        expect(capture.snapshot.time_bank_snapshot.players[id(11)]).toMatchObject({
          remainingSeconds: 7,
          usesRemaining: 1,
          unlimitedActivations: true,
        });
        const canonical = {
          operations: [],
          tables: [{ id: id(3) }],
          attempts: [],
          originals: [],
          pending_original_tables: [],
          no_start_continuations: [],
        };
        const r = mixedResponse(name, a);
        r.data.canonical = canonical;
        if (r.data.receipt) {
          r.data.receipt.canonical_proof = canonical;
          if (savedReceipt) expect(r.data.receipt.transfer_id).toBe(savedReceipt.transfer_id);
          savedReceipt = r.data.receipt;
          if (outcome === 'lost-reply' && !lost) {
            lost = true;
            return { data: null, error: { message: 'committed reply lost' } };
          }
        }
        return r;
      }
      if (name === 'fn_f06_find_mixed_manager_custody')
        return {
          data: { ok: true, tournament_id: id(1), receipt: transfer?.receipt ?? null },
          error: null,
        };
      if (name === 'fn_f06_admit_mixed_manager_custody') return mixedResponse(name, a);
      if (name === 'fn_f06_complete_mixed_manager_custody') {
        nativeRow = structuredClone(
          transfer.local.engines[0].bank_custody.stopped_capture.snapshot
        );
        return {
          data: {
            ok: true,
            transfer_id: transfer.transferId,
            tournament_id: id(1),
            lease_generation: transfer.successorGeneration,
            completion: {
              transfer_id: transfer.transferId,
              generation: transfer.successorGeneration,
              operation_receipts: [],
              presence_receipts: [],
            },
          },
          error: null,
        };
      }
      throw new Error(`unexpected bank-only RPC ${name}`);
    });
    mocks.release.mockImplementationOnce(async () => {
      transfer = s.drainedF06TournamentCustody.get(id(1)).mixed;
      expect(transfer.receipt).toBeTruthy();
      expect(engine.hasUnretiredStoppedTimeBankCustody()).toBe(false);
      expect(s.tournamentEngines.has(id(1))).toBe(false);
      return { status: 'confirmed', attempts: 1 };
    });
    const maintenance: any = new MaintenanceBreak({
      engines: () => s.enginesIncludingMixedF06Custody(),
      isRunning: () => true,
      emit: vi.fn(),
      store: { save: vi.fn(), clear: vi.fn() },
      now: () => Date.now(),
    } as any);
    maintenance.phase = 'counting_down';
    if (outcome === 'lost-reply') {
      await expect(s.stopTournamentManagerIfOwned(id(1), m, 'bank-only')).rejects.toThrow(
        'transfer_unproven'
      );
      expect(savedReceipt).toBeTruthy();
      expect(engine.hasUnretiredStoppedTimeBankCustody()).toBe(true);
      expect(s.tableEngines.get(id(3))).toBe(engine);
      expect(s.tournamentEngines.get(id(1))).toBe(m);
      expect(mocks.release).not.toHaveBeenCalled();
      expect(maintenance.unparkedTables()).toEqual([id(3)]);
    }
    expect(await s.stopTournamentManagerIfOwned(id(1), m, 'bank-only')).toBe(true);
    expect(maintenance.unparkedTables()).toEqual([]);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(transfer.local.engines[0].bank_custody.durable_presence).toBeNull();
    mocks.claim.mockImplementation(async (_id, generation) => ({
      status: 'granted',
      leaseGeneration: generation,
      proofDeadlineMonotonicMs: performance.now() + 30_000,
    }));
    const resume = vi
      .spyOn(TournamentManager.prototype, 'resume')
      .mockImplementation(async function (this: any) {
        expect(nativeRow.time_bank_snapshot.players[id(11)]).toMatchObject({
          remainingSeconds: 7,
          usesRemaining: 1,
          unlimitedActivations: true,
        });
        const next: any = new ServerTableEngine(id(3), {
          scope: 'tournament',
          verified: true,
          tournamentId: id(1),
          generation: transfer.successorGeneration,
          proofDeadlineMonotonicMs: performance.now() + 30_000,
        });
        next.tableInfo = { tournament_id: id(1) };
        next.handCount = 12;
        next.running = true;
        expect(next.claimProcessOwnership()).toBe(true);
        mocks.from.mockReturnValue({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: nativeRow, error: null }) }),
          }),
        });
        await next.readParkedTimeBanks();
        next.adoptSeatRoster([
          { user_id: id(11), occupancy_id: id(31), seat_number: 1, stack: 1500 },
        ]);
        expect(next.timeBankEngine.getPlayerBank(id(3), id(11))).toMatchObject({
          remainingSeconds: 7,
          usesRemaining: 1,
          unlimitedActivations: true,
        });
        await next.stop();
      });
    await s.performTournamentManagerAdmission(id(1), 'resume', 'bank-only successor', 1);
    const successor = s.tournamentEngines.get(id(1));
    managers.push(successor);
    expect(successor.isF06RecoveryOwner()).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
    expect(s.drainedF06TournamentCustody.has(id(1))).toBe(false);
    expect(s.mixedF06PreparationBlockers()).toEqual([]);
    expect([...s.enginesIncludingMixedF06Custody()]).toEqual([]);
  }
);

it('receipt-only successor consumes separately absent original move before completion and later ordinary restart', async () => {
  const { s, successor, transfer, winners, calls, resume } = await recoverableMixedScene(
    undefined,
    true
  );
  expect(winners.size).toBe(2);
  expect(
    calls.filter((c) => c.name === 'fn_move_tournament_player').map((c) => c.args.p_request_id)
  ).toEqual([id(12), id(12), id(24)]);
  expect(calls.some((c) => c.name === 'fn_f06_ack_cleanup')).toBe(true);
  expect(calls.some((c) => c.name === 'fn_f06_complete_mixed_manager_custody')).toBe(true);
  expect(successor.pendingTournamentSeatMoveOutcomes.size).toBe(0);
  expect(s.mixedF06PreparationBlockers()).toEqual([]);
  expect(resume).toHaveBeenCalledOnce();
  const replacement = server();
  await replacement.performTournamentManagerAdmission(id(1), 'resume', 'ordinary later restart', 1);
  const ordinary = replacement.tournamentEngines.get(id(1));
  managers.push(ordinary);
  expect(ordinary.isF06RecoveryOwner()).toBe(false);
  expect(ordinary.getTournamentLeaseGeneration()).not.toBe(transfer.successorGeneration);
});
