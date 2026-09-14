import { afterEach, expect, test, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import * as leases from '../services/tournamentLease.js';

const tournamentId = 'aaaaaaaa-0000-4000-8000-000000000001';
const generation = 'bbbbbbbb-0000-4000-8000-000000000001';
const successorGeneration = 'cccccccc-0000-4000-8000-000000000001';
class Harness extends TournamentManagerBase {
  protected startEliminationChecker() {}
  protected async recalculateEliminatedPrizes() {
    return true;
  }
  protected async resolveTournamentSeatMoveQuarantine() {
    return true;
  }
}
function manager(gen = generation): any {
  return new Harness(tournamentId, {} as any, gen, performance.now() + 20000);
}
function server(original: any): any {
  return Object.assign(Object.create(GameServer.prototype), {
    tournamentEngines: new Map([[tournamentId, original]]),
    tournamentManagerRetirementOperations: new WeakMap(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
  });
}
afterEach(() => vi.restoreAllMocks());

test('records the awaited exact release before deleting pending state, including confirmed zero', async () => {
  for (const releasedCount of [0, 1]) {
    const original = manager();
    const game = server(original);
    vi.spyOn(leases, 'releaseTournaments').mockResolvedValue({
      status: 'confirmed',
      attempts: 1,
      releasedCount,
    });
    const emission = vi.spyOn(console, 'info').mockImplementation((_prefix, serialized) => {
      expect(game.tournamentManagerPendingLeaseReleases.get(tournamentId)).toBe(generation);
      expect(JSON.parse(serialized)).toMatchObject({
        managerInstanceId: original.getLeaseReleaseDiagnosticSnapshot().instanceId,
        tournamentId,
        leaseGeneration: generation,
        releasedCount,
      });
    });
    await expect(game.stopTournamentManagerIfOwned(tournamentId, original, 'test')).resolves.toBe(
      true
    );
    expect(leases.releaseTournaments).toHaveBeenCalledWith([
      { tournamentId, leaseGeneration: generation },
    ]);
    expect(emission).toHaveBeenCalledOnce();
    expect(game.tournamentManagerPendingLeaseReleases.size).toBe(0);
    expect(original.getLeaseReleaseDiagnosticSnapshot().leaseRelease).toMatchObject({
      diagnosticOnly: true,
      status: 'confirmed',
      attempts: 1,
      releasedCount,
    });
    vi.restoreAllMocks();
  }
});

test('a delayed result after replacement records only the original object and generation', async () => {
  const original = manager();
  const game = server(original);
  let resolve!: (result: leases.TournamentLeaseReleaseOutcome) => void;
  vi.spyOn(leases, 'releaseTournaments').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const emission = vi.spyOn(console, 'info').mockImplementation(() => {});
  const retiring = game.stopTournamentManagerIfOwned(tournamentId, original, 'test');
  await new Promise<void>((done) => setImmediate(done));
  expect(original.getLeaseReleaseDiagnosticSnapshot().leaseRelease).toBe(
    'unobserved-owner-boundary'
  );
  const successor = manager(successorGeneration);
  game.tournamentEngines.set(tournamentId, successor);
  game.tournamentManagerPendingLeaseReleases.set(tournamentId, successorGeneration);
  resolve({ status: 'confirmed', attempts: 2, releasedCount: 1 });
  await retiring;
  expect(game.tournamentEngines.get(tournamentId)).toBe(successor);
  expect(game.tournamentManagerPendingLeaseReleases.get(tournamentId)).toBe(successorGeneration);
  expect(successor.getLeaseReleaseDiagnosticSnapshot().leaseRelease).toBe(
    'unobserved-owner-boundary'
  );
  expect(original.getLeaseReleaseDiagnosticSnapshot().leaseRelease).toMatchObject({
    managerInstanceId: original.getLeaseReleaseDiagnosticSnapshot().instanceId,
    leaseGeneration: generation,
    status: 'confirmed',
  });
  expect(emission).toHaveBeenCalledOnce();
  await successor.stop();
});

test('uncertain release remains a failure, preserves pending state and emits no raw details', async () => {
  const original = manager();
  const game = server(original);
  vi.spyOn(leases, 'releaseTournaments').mockResolvedValue({
    status: 'uncertain',
    attempts: 2,
    reason: 'rpc_error',
    detail: 'PRIVATE_DATABASE_DETAIL',
  });
  const emission = vi.spyOn(console, 'info').mockImplementation(() => {});
  await expect(game.stopTournamentManagerIfOwned(tournamentId, original, 'test')).rejects.toThrow(
    'Tournament lease release was not confirmed'
  );
  expect(game.tournamentManagerPendingLeaseReleases.get(tournamentId)).toBe(generation);
  const observation = original.getLeaseReleaseDiagnosticSnapshot().leaseRelease;
  expect(observation).toMatchObject({ status: 'uncertain', attempts: 2, releasedCount: null });
  expect(Object.isFrozen(observation)).toBe(true);
  const serialized = emission.mock.calls[0][1] as string;
  expect(serialized).not.toContain('PRIVATE_DATABASE_DETAIL');
  expect(serialized).not.toContain('rpc_error');
  expect(serialized.length).toBeLessThan(512);
});

test('wrong tournament or generation cannot bind; an observer cannot be rebound to another manager', async () => {
  const original = manager();
  const other = manager();
  expect(original.captureLeaseReleaseDiagnosticObserver('wrong', generation)).toBeNull();
  expect(
    original.captureLeaseReleaseDiagnosticObserver(tournamentId, successorGeneration)
  ).toBeNull();
  const observe = original.captureLeaseReleaseDiagnosticObserver(tournamentId, generation)!;
  observe.call(other, { status: 'confirmed', attempts: 1, releasedCount: 1 });
  expect(other.getLeaseReleaseDiagnosticSnapshot().leaseRelease).toBe('unobserved-owner-boundary');
  expect(original.getLeaseReleaseDiagnosticSnapshot().leaseRelease.managerInstanceId).toBe(
    original.getLeaseReleaseDiagnosticSnapshot().instanceId
  );
  await Promise.all([original.stop(), other.stop()]);
});

test('changed retained generation refuses a late diagnostic reply', async () => {
  const original = manager();
  const observe = original.captureLeaseReleaseDiagnosticObserver(tournamentId, generation)!;
  original.tournamentLeaseGeneration = successorGeneration;
  expect(observe({ status: 'confirmed', attempts: 1, releasedCount: 1 })).toBeNull();
  expect(original.getLeaseReleaseDiagnosticSnapshot().leaseRelease).toBe(
    'unobserved-owner-boundary'
  );
  await original.stop();
});

test('malformed counts and attempts never become confirmed diagnostic outcomes', async () => {
  const original = manager();
  const observe = original.captureLeaseReleaseDiagnosticObserver(tournamentId, generation)!;
  for (const result of [
    null,
    {},
    { status: 'unexpected', attempts: 1, releasedCount: 1 },
    ...[-1, 2, 0.5, '1', null, NaN].map((releasedCount) => ({
      status: 'confirmed',
      attempts: 1,
      releasedCount,
    })),
    ...[-1, 0, 3, 0.5, '1', null, NaN].map((attempts) => ({
      status: 'confirmed',
      attempts,
      releasedCount: 1,
    })),
  ]) {
    expect(observe(result)).toMatchObject({ status: 'unknown', releasedCount: null });
  }
  await original.stop();
});

test('stop failure neither invokes release nor fabricates a release observation', async () => {
  const original = manager();
  const game = server(original);
  vi.spyOn(original, 'stop').mockRejectedValue(new Error('stop refused'));
  const release = vi
    .spyOn(leases, 'releaseTournaments')
    .mockResolvedValue({ status: 'confirmed', attempts: 1, releasedCount: 1 });
  await expect(game.stopTournamentManagerIfOwned(tournamentId, original, 'test')).resolves.toBe(
    false
  );
  expect(release).not.toHaveBeenCalled();
  expect(game.tournamentEngines.get(tournamentId)).toBe(original);
  expect(original.getLeaseReleaseDiagnosticSnapshot().leaseRelease).toBe(
    'unobserved-owner-boundary'
  );
});
