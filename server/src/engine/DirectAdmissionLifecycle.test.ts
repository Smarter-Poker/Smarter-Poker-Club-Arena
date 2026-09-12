import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import * as errorReporter from '../services/errorReporter.js';
import { BoundedLeaseRenewalScope } from '../services/BoundedLeaseRenewalScope.js';

type Admission = 'ready' | 'not_wakeable' | 'owned_elsewhere' | 'retryable_failure';

function bareServer(): any {
  const server = Object.create(GameServer.prototype) as any;
  server.running = true;
  server.lifecycleGeneration = 7;
  server.leaderBootComplete = true;
  server.dealerPrerequisitesReady = true;
  server.dealerPrerequisiteGate = null;
  server.startOperation = null;
  server.teardownPromise = null;
  server.tournamentEngines = new Map();
  server.tableEngines = new Map();
  server.tournamentOwnedTables = new Set();
  server.directTableAdmissionOperations = new Map<string, Promise<Admission>>();
  server.directTableAdmissionLeaseGenerations = new Map<string, string>();
  server.directTableEngineRecoveryJobs = new Set<Promise<void>>();
  server.tournamentManagerAdmissionOperations = new Map<string, Promise<void>>();
  server.tournamentManagerLeaseReleaseOperations = new Map<string, Promise<boolean>>();
  server.tournamentManagerPendingLeaseReleases = new Map<string, string>();
  server.ownershipLeaseRenewalOperation = null;
  server.ownershipLeaseRenewalAbandoned = new WeakSet<Promise<void>>();
  server.cashLeaseRenewalScope = new BoundedLeaseRenewalScope();
  server.tournamentLeaseRenewalScope = new BoundedLeaseRenewalScope();
  server.shutdownOwnershipLeaseRenewalActive = false;
  server.discoveryJobs = new Set<Promise<void>>();
  server.serverLifecycleJobs = new Set<Promise<void>>();
  return server;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('direct table admission lifecycle', () => {
  it('holds concurrent table admissions outside all lookup and lease work until dealer boot is ready', async () => {
    const server = bareServer();
    server.resetDealerPrerequisiteGate(7);
    const enterAdmission = vi.fn(async (): Promise<Admission> => 'ready');
    server.performCashTableEngineAdmission = enterAdmission;

    const first = server.ensureCashTableEngineAdmission('table-before-ready') as Promise<Admission>;
    const concurrent = server.ensureCashTableEngineAdmission(
      'table-before-ready'
    ) as Promise<Admission>;
    await Promise.resolve();

    expect(enterAdmission).not.toHaveBeenCalled();
    expect(server.directTableAdmissionOperations.size).toBe(1);

    expect(server.publishDealerPrerequisitesReady(7)).toBe(true);
    await expect(first).resolves.toBe('ready');
    await expect(concurrent).resolves.toBe('ready');
    expect(enterAdmission).toHaveBeenCalledTimes(1);
  });

  it('never admits a table when standby or failed boot closes the prerequisite gate', async () => {
    {
      const server = bareServer();
      server.running = false;
      server.performStart = vi.fn().mockResolvedValue(undefined);
      const enterAdmission = vi.fn(async (): Promise<Admission> => 'ready');
      server.performCashTableEngineAdmission = enterAdmission;

      const starting = server.start() as Promise<void>;
      const admission = server.ensureCashTableEngineAdmission(
        'table-standby'
      ) as Promise<Admission>;
      await starting;

      await expect(admission).resolves.toBe('not_wakeable');
      expect(enterAdmission).not.toHaveBeenCalled();
      expect(server.directTableAdmissionOperations.size).toBe(0);
    }

    {
      const server = bareServer();
      server.running = false;
      const bootError = new Error('worker READY failed');
      server.performStart = vi.fn().mockRejectedValue(bootError);
      const enterAdmission = vi.fn(async (): Promise<Admission> => 'ready');
      server.performCashTableEngineAdmission = enterAdmission;

      const starting = server.start() as Promise<void>;
      const admission = server.ensureCashTableEngineAdmission('table-failed') as Promise<Admission>;
      await expect(starting).rejects.toBe(bootError);

      await expect(admission).resolves.toBe('not_wakeable');
      expect(enterAdmission).not.toHaveBeenCalled();
      expect(server.directTableAdmissionOperations.size).toBe(0);
    }
  });

  it('synchronously closes the prerequisite gate when shutdown wins during boot', async () => {
    const server = bareServer();
    server.running = false;
    const boot = deferred();
    server.performStart = vi.fn(async () => boot.promise);
    server.performStop = vi.fn().mockResolvedValue(undefined);
    const enterAdmission = vi.fn(async (): Promise<Admission> => 'ready');
    server.performCashTableEngineAdmission = enterAdmission;

    const starting = server.start() as Promise<void>;
    const admission = server.ensureCashTableEngineAdmission('table-stopping') as Promise<Admission>;
    const stopping = server.stop() as Promise<void>;

    await expect(admission).resolves.toBe('not_wakeable');
    expect(enterAdmission).not.toHaveBeenCalled();
    boot.resolve();
    await starting;
    await stopping;
  });

  it('publishes one boot operation and rejects a second lifecycle generation', async () => {
    const server = bareServer();
    server.running = false;
    const boot = deferred();
    server.performStart = vi.fn(async () => boot.promise);

    const first = server.start() as Promise<void>;
    const concurrent = server.start() as Promise<void>;
    expect(concurrent).toBe(first);
    expect(server.performStart).toHaveBeenCalledTimes(1);
    expect(server.performStart).toHaveBeenCalledWith(8);
    expect(server.running).toBe(true);
    expect(server.lifecycleGeneration).toBe(8);

    boot.resolve();
    await first;
    expect(server.start()).toBe(first);

    server.teardownPromise = Promise.resolve();
    await expect(server.start()).rejects.toThrow(/cannot be restarted/i);
    expect(server.performStart).toHaveBeenCalledTimes(1);
  });

  it('publishes one teardown promise and applies the ownership fence synchronously', async () => {
    const server = bareServer();
    const teardown = deferred();
    server.performStop = vi.fn(async () => teardown.promise);

    const first = server.stop() as Promise<void>;
    const concurrent = server.stop() as Promise<void>;
    expect(concurrent).toBe(first);
    expect(server.performStop).toHaveBeenCalledTimes(1);
    expect(server.running).toBe(false);
    expect(server.leaderBootComplete).toBe(false);
    expect(server.lifecycleGeneration).toBe(8);

    teardown.resolve();
    await first;
    expect(server.stop()).toBe(first);
  });

  it('starts the external ownership fence synchronously and makes it part of teardown', async () => {
    const server = bareServer();
    const barrier = deferred();
    const externalStop = vi.fn(() => barrier.promise);
    server.registerExternalShutdownOwnershipBarrier(externalStop);
    expect(() => server.registerExternalShutdownOwnershipBarrier(() => Promise.resolve())).toThrow(
      /already registered/i
    );
    server.performStop = vi.fn(async (_managers: unknown, externalOwnership: Promise<unknown>) => {
      await externalOwnership;
    });

    const stopping = server.stop() as Promise<void>;
    expect(externalStop).toHaveBeenCalledTimes(1);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped, 'teardown ignored the external owner still draining').toBe(false);

    barrier.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('collapses concurrent lookup/claim operations and fences their result on shutdown', async () => {
    const server = bareServer();
    let releaseLookup!: () => void;
    const lookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    server.performCashTableEngineAdmission = vi.fn(
      async (_tableId: string, generation: number): Promise<Admission> => {
        await lookup;
        return server.directAdmissionIsCurrent(generation) ? 'ready' : 'not_wakeable';
      }
    );

    const first = server.ensureCashTableEngineAdmission('table-1') as Promise<Admission>;
    const second = server.ensureCashTableEngineAdmission('table-1') as Promise<Admission>;
    await Promise.resolve();
    expect(server.performCashTableEngineAdmission).toHaveBeenCalledTimes(1);

    // This is stop()'s synchronous ownership fence while the lookup is still
    // suspended. The continuation must not publish its pre-shutdown result.
    server.running = false;
    server.lifecycleGeneration += 1;
    releaseLookup();

    await expect(first).resolves.toBe('not_wakeable');
    await expect(second).resolves.toBe('not_wakeable');
    expect(server.directTableAdmissionOperations.size).toBe(0);
  });

  it('retires a rejected operation so the next causal attempt can really run', async () => {
    const server = bareServer();
    server.performCashTableEngineAdmission = vi
      .fn<() => Promise<Admission>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce('ready');

    await expect(server.ensureCashTableEngineAdmission('table-2')).rejects.toThrow(
      'database unavailable'
    );
    expect(server.directTableAdmissionOperations.size).toBe(0);
    await expect(server.ensureCashTableEngineAdmission('table-2')).resolves.toBe('ready');
    expect(server.performCashTableEngineAdmission).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed generation visible when teardown has not released process ownership', async () => {
    const server = bareServer();
    const teardownError = new Error('scheduler ownership still held');
    const engine = {
      getEngineLeaseAuthority: vi.fn(() => null),
      stop: vi.fn().mockRejectedValue(teardownError),
      hasReleasedProcessOwnership: vi.fn(() => false),
    };
    server.tableEngines.set('table-owned', engine);

    await expect(
      server.performDirectTableEngineRecovery('table-owned', engine, 'test', false)
    ).rejects.toBe(teardownError);
    expect(server.tableEngines.get('table-owned')).toBe(engine);
    expect(engine.hasReleasedProcessOwnership).toHaveBeenCalledTimes(1);
  });

  it('does not let shutdown outrun a detached discovery mutation', async () => {
    const server = bareServer();
    const mutation = deferred();
    server.launchDiscoveryJob(mutation.promise, 'test.discovery');

    let drained = false;
    const draining = (server.drainDiscoveryJobs() as Promise<void>).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(server.discoveryJobs.size).toBe(1);

    mutation.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(server.discoveryJobs.size).toBe(0);
  });

  it('does not let shutdown outrun timer, subscription, boot, or repair work', async () => {
    const server = bareServer();
    const mutation = deferred();
    server.launchServerLifecycleJob(mutation.promise, 'test.lifecycle');

    let drained = false;
    const draining = (server.drainServerLifecycleJobs() as Promise<void>).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(server.serverLifecycleJobs.size).toBe(1);

    mutation.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(server.serverLifecycleJobs.size).toBe(0);
  });

  it('drains cross-registry continuations to one global fixed point', async () => {
    const server = bareServer();
    const firstMutation = deferred();
    const nestedMutation = deferred();
    server.launchServerLifecycleJob(
      firstMutation.promise.then(() => {
        server.launchDiscoveryJob(nestedMutation.promise, 'test.nested-discovery');
      }),
      'test.first-lifecycle'
    );

    let drained = false;
    const draining = (server.drainOwnedLifecycleJobs() as Promise<void>).then(() => {
      drained = true;
    });
    firstMutation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(server.discoveryJobs.size).toBe(1);

    nestedMutation.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('drains direct and tournament admission registries to a fixed point', async () => {
    const server = bareServer();
    const direct = deferred();
    const tournament = deferred();
    server.directTableAdmissionOperations.set('table', direct.promise);
    server.tournamentManagerAdmissionOperations.set('tournament', tournament.promise);

    let admissionsDrained = false;
    const draining = Promise.all([
      server.drainDirectTableAdmissions(),
      server.drainTournamentManagerAdmissions(),
    ]).then(() => {
      admissionsDrained = true;
    });
    await Promise.resolve();
    expect(admissionsDrained).toBe(false);

    direct.resolve();
    tournament.resolve();
    server.directTableAdmissionOperations.clear();
    server.tournamentManagerAdmissionOperations.clear();
    await draining;
    expect(admissionsDrained).toBe(true);
  });

  it('settles the real shutdown pass through both scopes without a swallowed renewal error', async () => {
    vi.useFakeTimers();
    const server = bareServer();
    server.running = false;
    server.shutdownOwnershipLeaseRenewalActive = true;
    const cash = vi.spyOn(server.cashLeaseRenewalScope, 'run');
    const tournament = vi.spyOn(server.tournamentLeaseRenewalScope, 'run');
    const report = vi.spyOn(errorReporter, 'reportError').mockImplementation(() => {});
    try {
      const loop = server.runShutdownOwnershipLeaseRenewalLoop();
      server.shutdownOwnershipLeaseRenewalOperation = loop;
      expect(cash).toHaveBeenCalledTimes(1);
      expect(tournament).toHaveBeenCalledTimes(1);
      await expect(cash.mock.results[0].value).resolves.toBeInstanceOf(Map);
      await expect(tournament.mock.results[0].value).resolves.toBeInstanceOf(Map);
      const stopping = server.stopShutdownOwnershipLeaseRenewal();
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      expect(
        report.mock.calls.some(
          ([, label]) => label === 'GameServer.shutdown_lease_renewal_pass_threw'
        )
      ).toBe(false);
      expect(server.shutdownOwnershipLeaseRenewalActive).toBe(false);
      expect(server.ownershipLeaseRenewalOperation).toBeNull();
    } finally {
      cash.mockRestore();
      tournament.mockRestore();
      report.mockRestore();
      vi.useRealTimers();
    }
  });

  it('serializes primary and shutdown heartbeat callers through one ownership pass', async () => {
    const server = bareServer();
    const pass = deferred();
    server.performOwnedEngineLeaseProofRenewal = vi.fn(() => pass.promise);

    const primary = server.renewOwnedEngineLeaseProofs() as Promise<void>;
    const shutdown = server.renewOwnedEngineLeaseProofs() as Promise<void>;
    expect(shutdown).toBe(primary);
    expect(server.performOwnedEngineLeaseProofRenewal).toHaveBeenCalledTimes(1);

    pass.resolve();
    await primary;
    expect(server.ownershipLeaseRenewalOperation).toBeNull();

    server.performOwnedEngineLeaseProofRenewal.mockResolvedValue(undefined);
    await server.renewOwnedEngineLeaseProofs();
    expect(server.performOwnedEngineLeaseProofRenewal).toHaveBeenCalledTimes(2);
  });

  it('renews ownership beyond the proof window while discovery remains blocked', async () => {
    vi.useFakeTimers();
    const server = bareServer();
    const discovery = deferred();
    const discoveryOperation = discovery.promise;
    server.launchDiscoveryJob(discoveryOperation, 'test.blocked-discovery');
    server.renewOwnedEngineLeaseProofs = vi.fn().mockResolvedValue(undefined);

    const renewalLoop = server.runOwnershipLeaseRenewalLoop(7) as Promise<void>;
    await vi.advanceTimersByTimeAsync(20_001);

    expect(server.renewOwnedEngineLeaseProofs.mock.calls.length).toBeGreaterThanOrEqual(5);
    let discoveryFinished = false;
    void discoveryOperation.then(() => {
      discoveryFinished = true;
    });
    await Promise.resolve();
    expect(discoveryFinished).toBe(false);
    expect(server.discoveryJobs.size).toBe(1);

    server.running = false;
    server.lifecycleGeneration = 8;
    await vi.advanceTimersByTimeAsync(5_000);
    await renewalLoop;
    discovery.resolve();
    await discoveryOperation;
  });
});
