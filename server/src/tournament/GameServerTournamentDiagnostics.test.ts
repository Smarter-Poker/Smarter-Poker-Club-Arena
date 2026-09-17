import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { tournamentEliminationScheduler } from './TournamentEliminationScheduler.js';
import * as leases from '../services/tournamentLease.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
class Harness extends TournamentManagerBase {
  protected startEliminationChecker() {}
  protected async recalculateEliminatedPrizes() {
    return true;
  }
  protected async resolveTournamentSeatMoveQuarantine() {
    return true;
  }
}
function manager(generation = id(2)): any {
  return new Harness(id(1), {} as any, generation, performance.now() + 20_000);
}
function server(current?: any): any {
  return Object.assign(Object.create(GameServer.prototype), {
    tournamentEngines: new Map(current ? [[id(1), current]] : []),
    tournamentManagerRetirementOperations: new WeakMap(),
    tournamentDiagnosticRetirements: new Map(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
    processStartedAt: 123,
  });
}
function scheduler(entries: any[] = []) {
  return vi.spyOn(tournamentEliminationScheduler, 'diagnosticSnapshot').mockReturnValue({
    tournamentId: id(1),
    activeEntriesCount: entries.length,
    activeEntriesScanned: entries.length,
    activeScanTruncated: false,
    matchingEntriesCountLowerBound: entries.length,
    entries,
    missingMeans: 'unknown',
  });
}
afterEach(() => vi.restoreAllMocks());

describe('bounded GameServer exact-owner read', () => {
  it('keeps current, retiring and scheduler originals separate across replacement without authority calls', async () => {
    const old = manager(),
      replacement = manager(id(3)),
      game = server(replacement);
    const oldSnapshot = old.getLifecycleDiagnosticSnapshot();
    game.tournamentDiagnosticRetirements.set(id(1), new Set([old]));
    scheduler([{ managerInstanceId: oldSnapshot.instanceId, owner: oldSnapshot }]);
    const authority = vi
      .spyOn(replacement, 'getTournamentLeaseGeneration')
      .mockImplementation(() => {
        throw new Error('not an observation');
      });
    const stop = vi.spyOn(replacement, 'stop');
    const result = game.getTournamentLifecycleDiagnostic(
      id(1),
      {},
      {
        managerInstanceId: oldSnapshot.instanceId,
        leaseGeneration: id(2),
      }
    );
    expect(result).toMatchObject({
      currentManagerPresent: true,
      expectedIdentityMatch: 'mismatch',
      retirementOperationsCount: 1,
    });
    expect(result.owners).toHaveLength(2);
    expect(
      result.owners.find((row: any) => row.snapshot.instanceId === oldSnapshot.instanceId).roles
    ).toEqual(['retiring', 'scheduler']);
    expect(result.scheduler.entries[0]).not.toHaveProperty('owner');
    expect(authority).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    authority.mockRestore();
    await old.stop();
    await replacement.stop();
  });

  it('retains exact old manager during the real map-removal to release-result interval', async () => {
    const old = manager(),
      game = server(old);
    scheduler();
    let release!: (result: leases.TournamentLeaseReleaseOutcome) => void;
    const request = vi.spyOn(leases, 'releaseTournaments').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const retiring = game.stopTournamentManagerIfOwned(id(1), old, 'test');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const observed = game.getTournamentLifecycleDiagnostic(id(1));
    expect(observed).toMatchObject({
      currentManagerPresent: false,
      releaseBarrierPresent: true,
      retirementOperationsCount: 1,
      pendingLeaseGeneration: id(2),
    });
    expect(observed.owners[0].snapshot.instanceId).toBe(
      old.getLeaseReleaseDiagnosticSnapshot().instanceId
    );
    expect(observed.owners[0].snapshot.leaseRelease).toBe('unobserved-owner-boundary');
    release({ status: 'confirmed', attempts: 1, releasedCount: 1 });
    await expect(retiring).resolves.toBe(true);
    expect(game.tournamentDiagnosticRetirements.size).toBe(0);
    expect(game.tournamentManagerLeaseReleaseOperations.size).toBe(0);
    expect(game.getTournamentLifecycleDiagnostic(id(1)).owners).toEqual([]);
  });

  it('cleans only the original diagnostic index entry after a rejected release', async () => {
    const old = manager(),
      successor = manager(id(3)),
      game = server(old);
    scheduler();
    const failure = new Error('release transport failed');
    let reject!: (error: unknown) => void;
    vi.spyOn(leases, 'releaseTournaments').mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const retiring = game.stopTournamentManagerIfOwned(id(1), old, 'test');
    const rejected = expect(retiring).rejects.toBe(failure);
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    game.tournamentDiagnosticRetirements.get(id(1)).add(successor);
    game.tournamentEngines.set(id(1), successor);
    reject(failure);
    await rejected;
    expect(game.tournamentDiagnosticRetirements.get(id(1))).toEqual(new Set([successor]));
    expect(game.tournamentEngines.get(id(1))).toBe(successor);
    expect(game.tournamentManagerPendingLeaseReleases.get(id(1))).toBe(id(2));
    game.tournamentDiagnosticRetirements.clear();
    await successor.stop();
  });

  it('failed stop retains existing ownership and never claims release', async () => {
    const old = manager(),
      game = server(old);
    const stop = vi.spyOn(old, 'stop').mockRejectedValue(new Error('owned stop failure'));
    const release = vi.spyOn(leases, 'releaseTournaments');
    await expect(game.stopTournamentManagerIfOwned(id(1), old, 'test')).resolves.toBe(false);
    expect(game.tournamentEngines.get(id(1))).toBe(old);
    expect(game.tournamentDiagnosticRetirements.size).toBe(0);
    expect(release).not.toHaveBeenCalled();
    stop.mockRestore();
    await old.stop();
  });

  it('missing or unreadable owners remain unavailable and scans/output are bounded', async () => {
    scheduler();
    const game = server();
    expect(
      game.getTournamentLifecycleDiagnostic(id(1), {}, { leaseGeneration: id(2) })
    ).toMatchObject({
      currentManagerPresent: false,
      expectedIdentityMatch: 'unavailable',
      owners: [],
    });
    const owners = Array.from({ length: 40 }, (_, n) => ({
      getLifecycleDiagnosticSnapshot: () => ({
        instanceId: id(100 + n),
        tournamentId: id(1),
        leaseGeneration: id(2),
      }),
    }));
    game.tournamentDiagnosticRetirements.set(id(1), new Set(owners));
    const result = game.getTournamentLifecycleDiagnostic(id(1));
    expect(result).toMatchObject({
      retirementOperationsCount: 40,
      retirementEntriesScanned: 32,
      retirementScanTruncated: true,
      ownersObservedCountLowerBound: 32,
      ownersOmitted: 28,
    });
    expect(result.owners).toHaveLength(4);
    game.tournamentEngines.set(id(1), {
      getLifecycleDiagnosticSnapshot: () => {
        throw new Error('unavailable');
      },
    });
    expect(game.getTournamentLifecycleDiagnostic(id(1))).toMatchObject({
      currentManagerPresent: true,
      unavailableOwners: 1,
    });
  });

  it('diagnostic index setup and cleanup failures cannot replace the physical result', async () => {
    for (const edge of ['setup', 'cleanup'] as const) {
      const old = manager(),
        game = server(old);
      vi.spyOn(leases, 'releaseTournaments').mockResolvedValue({
        status: 'confirmed',
        attempts: 1,
        releasedCount: 1,
      });
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(
        game.tournamentDiagnosticRetirements,
        edge === 'setup' ? 'set' : 'delete'
      ).mockImplementation(() => {
        throw new Error('diagnostic index only');
      });
      await expect(game.stopTournamentManagerIfOwned(id(1), old, 'test')).resolves.toBe(true);
      expect(game.tournamentManagerRetirementOperations.has(old)).toBe(false);
      expect(game.tournamentManagerLeaseReleaseOperations.size).toBe(0);
      expect(game.tournamentDiagnosticIndexFailures).toBeGreaterThan(0);
      vi.restoreAllMocks();
      scheduler();
      expect(game.getTournamentLifecycleDiagnostic(id(1))).toMatchObject({
        retirementIndexCoverage: 'unavailable',
        retirementOperationsCount: null,
      });
      vi.restoreAllMocks();
    }
  });
});
