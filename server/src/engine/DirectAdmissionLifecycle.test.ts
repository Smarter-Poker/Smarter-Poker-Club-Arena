import { describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';

type Admission = 'ready' | 'not_wakeable' | 'owned_elsewhere' | 'retryable_failure';

function bareServer(): any {
  const server = Object.create(GameServer.prototype) as any;
  server.running = true;
  server.lifecycleGeneration = 7;
  server.leaderBootComplete = true;
  server.startOperation = null;
  server.teardownPromise = null;
  server.tournamentEngines = new Map();
  server.tableEngines = new Map();
  server.tournamentOwnedTables = new Set();
  server.directTableAdmissionOperations = new Map<string, Promise<Admission>>();
  server.directTableEngineRecoveryJobs = new Set<Promise<void>>();
  server.tournamentManagerAdmissionOperations = new Map<string, Promise<void>>();
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

describe('direct table admission lifecycle', () => {
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
});
