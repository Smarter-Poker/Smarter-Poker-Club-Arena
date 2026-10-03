/**
 * A STOP THAT NEVER RETURNS DOES NOT KEEP THE EVENT (2026-10-03).
 *
 * Spin 20a7de08 dealt its last hand at 16:33:34. Its lease was last renewed
 * at 16:34:22 and kept naming the live instance 1-14d6b5c1 until about 19:2x
 * while 221 sibling leases renewed normally; the orphan sweep filed a
 * CRITICAL at 16:52, 17:52 and 18:52. The renewal pass fences a manager whose
 * proof lapsed and launches stopTournamentManagerIfOwned; when the physical
 * stop never settles (an await stranded by the 16:34:50 database restart),
 * nothing after it ran - no quarantine record, no lease release, no free slot
 * for re-adoption - and every later pass returned the same pending operation.
 *
 * These cases reproduce that with a teardown await that never settles, on
 * fake timers, and pin the cure: within the bound the fenced manager is
 * evicted, its EXACT generation is released, the successor barrier opens, and
 * nothing about fencing against another generation is relaxed.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import {
  STRANDED_TOURNAMENT_MANAGER_STOP_MS,
  strandedTournamentManagerEvictions,
} from './TournamentManagerOwnership.js';
import { surrenderProcessOwnershipOfStrandedTeardown } from '../engine/strandedTeardownOwnership.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import * as leases from '../services/tournamentLease.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import {
  _setEngineLeaseMonotonicNowForTests,
  type EngineLeaseAuthority,
} from '../engine/ServerTableEngineBase.js';

const tournamentId = 'aaaaaaaa-0000-4000-8000-000000000001';
const generation = 'bbbbbbbb-0000-4000-8000-000000000001';
const successorGeneration = 'cccccccc-0000-4000-8000-000000000001';
const TABLE = '9aa37b13-b89f-4db2-b6a8-23e411486c45';

const reported = vi.hoisted(() => [] as string[]);
vi.mock('../services/errorReporter.js', () => ({
  reportError: (error: unknown) => {
    reported.push(String((error as Error)?.message ?? error));
  },
}));

class Harness extends TournamentManagerBase {
  async captureDrainedF06Custody() {
    return null;
  }
  async captureMixedF06Custody() {
    return null;
  }
  protected startEliminationChecker() {}
  protected async recalculateEliminatedPrizes() {
    return true;
  }
  protected async resolveTournamentSeatMoveQuarantine() {
    return true;
  }
}

/** A manager whose teardown parks on an await the connection reset stranded. */
function strandedManager(gen = generation): any {
  const manager: any = new Harness(tournamentId, {} as any, gen, performance.now() + 20_000);
  manager.drainEliminationSchedulerJobs = () => new Promise<void>(() => undefined);
  return manager;
}

function server(manager: any): any {
  return Object.assign(Object.create(GameServer.prototype), {
    tournamentEngines: new Map([[tournamentId, manager]]),
    tableEngines: new Map(),
    tournamentOwnedTables: new Set<string>(),
    drainedF06TournamentCustody: new Map(),
    tournamentManagerAdmissionLeaseGenerations: new Map(),
    completedF06TournamentCustody: new Map(),
    tournamentManagerRetirementOperations: new WeakMap(),
    tournamentDiagnosticRetirements: new Map(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reported.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  _setEngineLeaseMonotonicNowForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('without a bound the 16:34 shape strands the event: nothing settles, nothing is released', async () => {
  const manager = strandedManager();
  const game = server(manager);
  const release = vi
    .spyOn(leases, 'releaseTournaments')
    .mockResolvedValue({ status: 'confirmed', attempts: 1, releasedCount: 1 });
  let settled = false;
  void game
    .stopTournamentManagerIfOwned(
      tournamentId,
      manager,
      'GameServer.tournament_lease_lost_stop_failed'
    )
    .then(() => (settled = true));
  // Every lease pass before the bound joins the same pending operation.
  const operation = game.tournamentManagerRetirementOperations.get(manager);
  await vi.advanceTimersByTimeAsync(STRANDED_TOURNAMENT_MANAGER_STOP_MS - 1_000);
  const again = game.stopTournamentManagerIfOwned(tournamentId, manager, 'again');
  expect(game.tournamentManagerRetirementOperations.get(manager)).toBe(operation);
  expect(settled).toBe(false);
  expect(game.tournamentEngines.get(tournamentId)).toBe(manager);
  expect(release).not.toHaveBeenCalled();
  // The successor barrier is still up: nobody may claim a new generation yet.
  expect(game.tournamentManagerLeaseReleaseOperations.has(tournamentId)).toBe(true);
  await vi.advanceTimersByTimeAsync(2_000);
  await again;
});

test('a stop stranded after a connection reset is evicted within the bound and its exact lease released', async () => {
  const evictionsBefore = strandedTournamentManagerEvictions();
  const manager = strandedManager();
  const game = server(manager);
  const release = vi
    .spyOn(leases, 'releaseTournaments')
    .mockResolvedValue({ status: 'confirmed', attempts: 1, releasedCount: 1 });
  const retiring = game.stopTournamentManagerIfOwned(
    tournamentId,
    manager,
    'GameServer.tournament_lease_lost_stop_failed'
  );
  const barrier = game.tournamentManagerLeaseReleaseOperations.get(tournamentId);
  expect(barrier).toBeInstanceOf(Promise);

  await vi.advanceTimersByTimeAsync(STRANDED_TOURNAMENT_MANAGER_STOP_MS);
  await expect(retiring).resolves.toBe(true);

  // The slot is free for re-adoption and the barrier opened on a confirmed release.
  expect(game.tournamentEngines.has(tournamentId)).toBe(false);
  await expect(barrier).resolves.toBe(true);
  expect(game.tournamentManagerLeaseReleaseOperations.has(tournamentId)).toBe(false);
  expect(game.tournamentManagerPendingLeaseReleases.has(tournamentId)).toBe(false);
  // Exactly the stranded generation was released - never anyone else's row.
  expect(release).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledWith([{ tournamentId, leaseGeneration: generation }]);
  // Not left in the quarantine, and named where an operator will see it.
  expect(game.tournamentManagerQuarantine?.heldBy(tournamentId) ?? null).toBeNull();
  expect(strandedTournamentManagerEvictions()).toBe(evictionsBefore + 1);
  expect(reported.some((m) => m.includes('evicted the fenced manager'))).toBe(true);
});

test('eviction never re-arms the stranded generation and never touches a successor', async () => {
  const manager = strandedManager();
  const game = server(manager);
  vi.spyOn(leases, 'releaseTournaments').mockResolvedValue({
    status: 'confirmed',
    attempts: 1,
    releasedCount: 1,
  });
  const retiring = game.stopTournamentManagerIfOwned(tournamentId, manager, 'test');
  await vi.advanceTimersByTimeAsync(STRANDED_TOURNAMENT_MANAGER_STOP_MS);
  await retiring;

  // The evicted generation is fenced for good: no authority, no renewal.
  expect(manager.hasCurrentTournamentLeaseAuthority()).toBe(false);
  expect(manager.renewTournamentLeaseProof(generation, performance.now() + 20_000)).toBe(false);

  // A successor admitted afterwards is untouched by anything the stranded
  // teardown or a repeated retirement does later.
  const successor = new Harness(
    tournamentId,
    {} as any,
    successorGeneration,
    performance.now() + 20_000
  ) as any;
  game.tournamentEngines.set(tournamentId, successor);
  await expect(game.stopTournamentManagerIfOwned(tournamentId, manager, 'late')).resolves.toBe(
    false
  );
  expect(game.tournamentEngines.get(tournamentId)).toBe(successor);
  expect(successor.hasCurrentTournamentLeaseAuthority()).toBe(true);
  await successor.stop();
});

test('custody a fresh generation cannot rebuild keeps the manager, named in the quarantine', async () => {
  const manager = strandedManager();
  manager.isF06RecoveryOwner = () => true;
  const game = server(manager);
  const release = vi.spyOn(leases, 'releaseTournaments');
  const retiring = game.stopTournamentManagerIfOwned(tournamentId, manager, 'test');
  await vi.advanceTimersByTimeAsync(STRANDED_TOURNAMENT_MANAGER_STOP_MS);
  await expect(retiring).resolves.toBe(false);
  expect(game.tournamentEngines.get(tournamentId)).toBe(manager);
  expect(release).not.toHaveBeenCalled();
  expect(game.tournamentManagerQuarantine.heldBy(tournamentId)).toBe(manager);
  expect(reported.some((m) => m.includes('was not evicted: f06_recovery_owner'))).toBe(true);
  // The successor barrier is not left hanging on the failed attempt.
  expect(game.tournamentManagerLeaseReleaseOperations.has(tournamentId)).toBe(false);
});

test('a stop that settles inside the bound is untouched by it', async () => {
  const evictionsBefore = strandedTournamentManagerEvictions();
  const manager: any = new Harness(tournamentId, {} as any, generation, performance.now() + 20_000);
  const game = server(manager);
  vi.spyOn(leases, 'releaseTournaments').mockResolvedValue({
    status: 'confirmed',
    attempts: 1,
    releasedCount: 1,
  });
  const retiring = game.stopTournamentManagerIfOwned(tournamentId, manager, 'test');
  await vi.advanceTimersByTimeAsync(10);
  await expect(retiring).resolves.toBe(true);
  expect(strandedTournamentManagerEvictions()).toBe(evictionsBefore);
  expect(reported.some((m) => m.includes('evicted'))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('a stranded table teardown gives its process slot back only once terminal', async () => {
  let now = 0;
  _setEngineLeaseMonotonicNowForTests(() => now);
  const authority = (deadline: number): EngineLeaseAuthority => ({
    scope: 'cash',
    verified: true,
    generation,
    proofDeadlineMonotonicMs: deadline,
  });
  const stranded: any = new ServerTableEngine(TABLE, authority(20_000));
  stranded.running = true;
  expect(stranded.claimProcessOwnership()).toBe(true);
  // Not terminal yet: it refuses and keeps the slot.
  expect(surrenderProcessOwnershipOfStrandedTeardown(stranded)).toBe(false);
  // Its settlement never answers; stop() parks on joining it.
  stranded.settlementInFlight = new Set([new Promise<void>(() => undefined)]);
  void stranded.stop().catch(() => undefined);
  expect(stranded.hasReleasedProcessOwnership()).toBe(false);
  const successor: any = new ServerTableEngine(TABLE, authority(40_000));
  expect(successor.claimProcessOwnership()).toBe(false);

  expect(surrenderProcessOwnershipOfStrandedTeardown(stranded)).toBe(true);
  expect(stranded.hasReleasedProcessOwnership()).toBe(true);
  expect(stranded.isRunning()).toBe(false);
  expect(successor.claimProcessOwnership()).toBe(true);
  // Idempotent, and it never takes a successor's slot back.
  expect(surrenderProcessOwnershipOfStrandedTeardown(stranded)).toBe(true);
  expect(successor.hasReleasedProcessOwnership()).toBe(false);
  now = 1;
});

test('a stranded manager with a stopped table frees the table registry slot and banks first', async () => {
  const manager = strandedManager();
  const unregister = vi.fn(() => true);
  manager.gameServer = { unregisterTournamentTableEngine: unregister };
  let banksOnDisk = false;
  const engine = {
    terminal: true,
    running: false,
    claimedProcessOwnership: false,
    tableId: TABLE,
    isRunning: () => false,
    hasClaimedTournamentMoveBoundary: () => false,
    hasUnretiredStoppedTimeBankCustody: () => !banksOnDisk,
    persistStoppedTimeBankCustody: vi.fn(async () => {
      banksOnDisk = true;
    }),
    fenceForEngineLeaseLoss: vi.fn(),
    // Its own teardown is the one stranded on a settlement that never answers.
    stop: () => new Promise<void>(() => undefined),
  };
  manager.tableEngines.set(TABLE, engine);
  const game = server(manager);
  vi.spyOn(leases, 'releaseTournaments').mockResolvedValue({
    status: 'confirmed',
    attempts: 1,
    releasedCount: 1,
  });
  const retiring = game.stopTournamentManagerIfOwned(tournamentId, manager, 'test');
  await vi.advanceTimersByTimeAsync(STRANDED_TOURNAMENT_MANAGER_STOP_MS);
  await expect(retiring).resolves.toBe(true);
  expect(engine.persistStoppedTimeBankCustody).toHaveBeenCalledOnce();
  expect(unregister).toHaveBeenCalledWith(TABLE, engine);
  expect(game.tournamentEngines.has(tournamentId)).toBe(false);
});

test('time banks that cannot be written down keep the manager, named and retried', async () => {
  const manager = strandedManager();
  const unregister = vi.fn(() => true);
  manager.gameServer = { unregisterTournamentTableEngine: unregister };
  manager.tableEngines.set(TABLE, {
    terminal: true,
    running: false,
    claimedProcessOwnership: false,
    tableId: TABLE,
    isRunning: () => false,
    hasClaimedTournamentMoveBoundary: () => false,
    hasUnretiredStoppedTimeBankCustody: () => true,
    persistStoppedTimeBankCustody: () => new Promise<void>(() => undefined),
    fenceForEngineLeaseLoss: vi.fn(),
    // Its own teardown is the one stranded on a settlement that never answers.
    stop: () => new Promise<void>(() => undefined),
  });
  const game = server(manager);
  const release = vi.spyOn(leases, 'releaseTournaments');
  const retiring = game.stopTournamentManagerIfOwned(tournamentId, manager, 'test');
  await vi.advanceTimersByTimeAsync(STRANDED_TOURNAMENT_MANAGER_STOP_MS + 15_000);
  await expect(retiring).resolves.toBe(false);
  expect(unregister).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(game.tournamentEngines.get(tournamentId)).toBe(manager);
  expect(game.tournamentManagerQuarantine.heldBy(tournamentId)).toBe(manager);
  expect(reported.some((m) => m.includes('time_bank_custody_not_on_disk'))).toBe(true);
});
