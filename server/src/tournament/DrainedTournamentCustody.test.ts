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
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: mocks.rpc, from: vi.fn() },
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
function stopped(s = server()) {
  const m = manager(s);
  const engines = [id(3), id(4)].map(
    (table) =>
      [
        table,
        {
          isRunning: () => false,
          hasReleasedProcessOwnership: () => true,
          hasSettlementInFlight: () => false,
          fenceForEngineLeaseLoss: () => undefined,
          hasClaimedTournamentMoveBoundary: () => false,
          hasOnlyDrainedTournamentMoveOwner: () => true,
        },
      ] as const
  );
  m.stopFenceApplied = true;
  m.tournamentLeaseAuthorityExpired = true;
  m.drainedF06Originals = engines;
  m.tableEngines = new Map(engines);
  s.tableEngines = new Map(engines);
  s.tournamentEngines.set(id(1), m);
  m.retainedTournamentBreakSources.set(id(3), { breakId: id(5), engine: engines[0][1] });
  m.durableTournamentBreaks.set(id(5), {
    lifecycle: '1',
    state: 'park_requested',
    revision: '0',
    members: [],
    custody_id: null,
    custody_generation: null,
    terminal_handoff_required: false,
  });
  return { s, m, engines };
}
beforeEach(() => {
  mocks.rpc
    .mockReset()
    .mockImplementation(async (name, a) =>
      name === 'fn_f06_find_mixed_manager_custody'
        ? { error: null, data: { ok: true, tournament_id: a.p_tournament_id, receipt: null } }
        : response(a)
    );
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
it('a genuinely leased recovery owner renews but never admits gameplay', async () => {
  const m = manager();
  m.enterF06RecoveryOwnership();
  expect(m.isF06RecoveryOwner()).toBe(true);
  expect(m.isRunning()).toBe(false);
  expect(m.eliminationMutationAllowed()).toBe(false);
  expect(m.renewTournamentLeaseProof(id(2), performance.now() + 30_000)).toBe(true);
  expect(m.stoodDownWithItsLeaseIntact()).toBe(false);
  await expect(m.resume()).rejects.toThrow('f06_recovery_business_admission_held');
  await expect(m.start()).rejects.toThrow('f06_recovery_business_admission_held');
  m.fenceForTournamentLeaseLoss();
  expect(m.isF06RecoveryOwner()).toBe(false);
  expect(m.renewTournamentLeaseProof(id(2), performance.now() + 30_000)).toBe(false);
});
it('does not repurpose a manager with an in-flight lifecycle', () => {
  const m = manager();
  m.lifecycleOperation = Promise.resolve();
  expect(() => m.enterF06RecoveryOwnership()).toThrow('f06_recovery_owner_invalid');
});
it('holds never-dealt discovery retirement only while a genuine recovery owner is current', () => {
  const s = server(),
    m = manager(s);
  m.enterF06RecoveryOwnership();
  s.launchDiscoveryJob = vi.fn();
  s.stopTournamentManagerIfOwned = vi.fn().mockResolvedValue(true);
  s.retireTournamentManagerInDiscovery(id(1), m, 'idle');
  expect(s.stopTournamentManagerIfOwned).not.toHaveBeenCalled();
  m.fenceForTournamentLeaseLoss();
  s.retireTournamentManagerInDiscovery(id(1), m, 'expired');
  expect(s.stopTournamentManagerIfOwned).toHaveBeenCalledOnce();
});
it('retains exact originals before releasing both activation maps', async () => {
  const { s, m, engines } = stopped();
  expect(await s.transferDrainedF06Custody(id(1), m)).toBe(true);
  const packet = s.drainedF06TournamentCustody.get(id(1));
  expect(packet.manager).toBe(m);
  expect(packet.engines).toBe(engines);
  expect(s.tableEngines.size).toBe(0);
  expect(s.tournamentEngines.size).toBe(0);
  expect(m.tableEngines.get(id(3))).toBe(engines[0][1]);
  expect(m.retainedTournamentBreakSources.size).toBe(1);
  expect(await s.transferDrainedF06Custody(id(1), m)).toBe(false);
});
it.each(['pending', 'queued', 'second-engine', 'foreign-owner', 'missing-positive-stop'])(
  'refuses %s during old assertion without partial deletion',
  async (fault) => {
    const { s, m, engines } = stopped();
    const paused = gate(),
      entered = gate();
    mocks.rpc.mockImplementation(async (_n, a) => {
      entered.resolve();
      await paused.promise;
      return response(a);
    });
    if (fault === 'missing-positive-stop') m.drainedF06Originals = null;
    const work = s.transferDrainedF06Custody(id(1), m);
    if (fault !== 'missing-positive-stop') {
      await entered.promise;
      if (fault === 'pending') m.pendingTournamentBreakBegins.set(id(6), {});
      if (fault === 'queued') void m.runWithTournamentSeatMoveAuthority(async () => undefined);
      if (fault === 'second-engine') s.tableEngines.set(id(4), {});
      if (fault === 'foreign-owner') {
        Object.assign(engines[0][1], {
          hasClaimedTournamentMoveBoundary: () => true,
          hasOnlyDrainedTournamentMoveOwner: () => false,
        });
      }
      paused.resolve();
    }
    expect(await work).toBe(false);
    expect(s.tournamentEngines.get(id(1))).toBe(m);
    expect(s.tableEngines.size).toBe(2);
    expect(s.drainedF06TournamentCustody.size).toBe(0);
  }
);
it('preserves packet and pending generation after unknown original release', async () => {
  const { s, m, engines } = stopped();
  m.stop = vi.fn().mockRejectedValue(new Error('unresolved-seat-move'));
  mocks.release.mockResolvedValue({
    status: 'unknown',
    reason: 'transport',
    attempts: 1,
    detail: 'unknown',
  });
  await expect(s.stopTournamentManagerIfOwned(id(1), m, 'stop')).rejects.toThrow('not confirmed');
  expect(s.drainedF06TournamentCustody.get(id(1)).engines).toBe(engines);
  expect(s.tournamentManagerPendingLeaseReleases.get(id(1))).toBe(id(2));
});
/* A FRESH ADOPTION HAS NO STRICT RECOVERY TO WAIT FOR (2026-09-26). This
   test used to pin the opposite: with no drained packet and no mixed
   transfer, a reserved hand made the successor a custody-only recovery owner
   that never resumed. Nothing ever continued that owner - the only one that
   can decide a dead generation's hand is the abandoned-generation door, which
   runs inside resume() - so 68 RUNNING events held their lease and never dealt
   on engine 778075b4. See f06RecoveryDispositionOwner. */
it('a fresh adoption with a reserved hand and no custody resumes instead of holding the lease', async () => {
  const s = server();
  const resume = vi.spyOn(TournamentManager.prototype, 'resume').mockImplementation(async function (
    this: any
  ) {
    managers.push(this);
    // resume() is entered as an ordinary manager: no custody-only hold that
    // would make it throw f06_recovery_business_admission_held.
    expect(this.isF06RecoveryOwner()).toBe(false);
    expect(this.tableEngines.size).toBe(0);
  });
  await s.performTournamentManagerAdmission(id(1), 'resume', 'test', 1);
  const m = s.tournamentEngines.get(id(1));
  expect(m.isF06RecoveryOwner()).toBe(false);
  expect(resume).toHaveBeenCalledOnce();
  // The retained original submission is still finished first.
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(mocks.release).not.toHaveBeenCalled();
  expect(s.finishTournamentManagerAdmission).toHaveBeenCalledOnce();
});
it('a drained in-process packet with a reserved hand keeps strict ownership and never resumes', async () => {
  const { s, m } = stopped();
  expect(await s.transferDrainedF06Custody(id(1), m)).toBe(true);
  const resume = vi.spyOn(TournamentManager.prototype, 'resume');
  mocks.rpc.mockClear();
  await s.performTournamentManagerAdmission(id(1), 'resume', 'test', 1);
  const successor = s.tournamentEngines.get(id(1));
  managers.push(successor);
  expect(successor).not.toBe(m);
  expect(successor.isF06RecoveryOwner()).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  expect(s.drainedF06TournamentCustody.has(id(1))).toBe(true);
  const asked = mocks.rpc.mock.calls.map(([name]) => name);
  expect(asked).not.toContain('fn_f06_hand_number_state');
  expect(asked).not.toContain('fn_f06_abort_abandoned_generation');
  expect(s.finishTournamentManagerAdmission).not.toHaveBeenCalled();
});
it('a door-owned adoption whose resume fails is stopped, not left holding the event', async () => {
  const s = server();
  vi.spyOn(TournamentManager.prototype, 'resume').mockImplementation(async function (this: any) {
    managers.push(this);
    throw new Error('door read failed before any dealer');
  });
  s.stopTournamentManagerIfOwned = vi.fn().mockResolvedValue(true);
  await expect(s.performTournamentManagerAdmission(id(1), 'resume', 'test', 1)).rejects.toThrow(
    'door read failed'
  );
  expect(s.stopTournamentManagerIfOwned).toHaveBeenCalledOnce();
  expect(s.finishTournamentManagerAdmission).not.toHaveBeenCalled();
});
it.each(['absent', 'unknown'])('keeps %s journal evidence as recovery custody', async (kind) => {
  if (kind === 'unknown') mocks.resume.mockRejectedValue(new Error('original pending'));
  const r = await prepareF06SuccessorAdmission(id(1), id(9), 'instance', null, () => true);
  expect(r.recoveryRequired).toBe(true);
  expect(mocks.resume).toHaveBeenCalledTimes(1);
});
it('preserves legitimate original journal completion before choosing gameplay', async () => {
  mocks.rpc
    .mockImplementationOnce(async (_n, a) => response(a))
    .mockImplementationOnce(async (_n, a) => response(a, []));
  mocks.resume.mockResolvedValue({ completed: true, handId: id(8) });
  expect(
    (await prepareF06SuccessorAdmission(id(1), id(9), 'instance', null, () => true))
      .recoveryRequired
  ).toBe(false);
  expect(mocks.resume).toHaveBeenCalledWith(id(4), 'instance', id(9));
});
it('refuses changed incarnation after awaited journal completion', async () => {
  let current = true;
  mocks.resume.mockImplementation(async () => {
    current = false;
    return null;
  });
  await expect(
    prepareF06SuccessorAdmission(id(1), id(9), 'instance', null, () => current)
  ).rejects.toThrow('admission_changed');
});
it('does not infer a read failure as an empty event', async () => {
  mocks.rpc.mockResolvedValue({ error: { message: 'unknown' }, data: null });
  mocks.rpc.mockResolvedValueOnce({
    error: null,
    data: { ok: true, tournament_id: id(1), receipt: null },
  });
  const s = server();
  await expect(s.performTournamentManagerAdmission(id(1), 'resume', 'test', 1)).rejects.toThrow(
    'custody_unproven'
  );
  expect(s.tournamentEngines.size).toBe(0);
  expect(mocks.release).toHaveBeenCalledOnce();
});
it('foreign claim preserves every old reference and starts nothing', async () => {
  const { s, m, engines } = stopped();
  await s.transferDrainedF06Custody(id(1), m);
  mocks.claim.mockResolvedValue({ status: 'owned_elsewhere' });
  mocks.rpc.mockClear();
  await s.performTournamentManagerAdmission(id(1), 'resume', 'test', 1);
  expect(s.drainedF06TournamentCustody.get(id(1)).engines).toBe(engines);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(s.tournamentEngines.size).toBe(0);
});
it('archives resolved originals before a new accepted hand and later startup failure', async () => {
  const { s, m, engines } = stopped();
  await s.transferDrainedF06Custody(id(1), m);
  const terminal = [{ permit: id(4), receipt: id(8) }];
  mocks.rpc.mockImplementation(async (_n, a) => response(a, [], terminal));
  const resume = vi.spyOn(TournamentManager.prototype, 'resume').mockImplementation(async function (
    this: any
  ) {
    managers.push(this);
    expect(s.drainedF06TournamentCustody.size).toBe(0);
    const archive = [...s.completedF06TournamentCustody.get(id(1))][0];
    expect(archive.original.engines).toBe(engines);
    expect(archive.terminalProof).toEqual(terminal);
    throw new Error('later startup after legitimate hand');
  });
  s.stopTournamentManagerIfOwned = vi.fn().mockResolvedValue(true);
  await expect(s.performTournamentManagerAdmission(id(1), 'resume', 'test', 1)).rejects.toThrow(
    'later startup'
  );
  expect(resume).toHaveBeenCalledOnce();
  expect(s.completedF06TournamentCustody.size).toBe(1);
  expect(s.drainedF06TournamentCustody.size).toBe(0);
});

it('breaks the actual failed-stop admission cycle only after every physical stop fulfilled', async () => {
  const { s, m, engines } = stopped();
  m.stopFenceApplied = false;
  m.drainedF06Originals = null;
  for (const [, engine] of engines)
    Object.assign(engine, { stop: vi.fn().mockResolvedValue(undefined) });
  vi.spyOn(m, 'resolveTournamentSeatMoveQuarantine').mockResolvedValue(false);
  expect(await s.stopTournamentManagerIfOwned(id(1), m, 'original-unresolved-park')).toBe(true);
  const packet = s.drainedF06TournamentCustody.get(id(1));
  expect(packet.manager).toBe(m);
  expect(packet.engines.map((entry: any) => entry[1])).toEqual(engines.map((entry) => entry[1]));
  for (const [, engine] of engines) expect((engine as any).stop).toHaveBeenCalledTimes(2);
  expect(m.tableEngines.get(id(3))).toBe(engines[0][1]);
  expect(s.tournamentEngines.size).toBe(0);
  expect(mocks.release).toHaveBeenCalledOnce();
});
