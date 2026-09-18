import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setTournamentLeaseMonotonicNowForTests } from '../services/tournamentLease.js';
import { GameServer } from '../GameServer.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import {
  _setEngineLeaseMonotonicNowForTests,
  type EngineLeaseAuthority,
} from '../engine/ServerTableEngineBase.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { TournamentManager } from './TournamentManager.js';
import type { TournamentLifecycleToken } from './TournamentLifecycleEpoch.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const TOURNAMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const GENERATION = 'bbbbbbbb-0000-4000-8000-000000000001';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class LeaseDeadlineHarness extends TournamentManagerBase {
  constructor(deadline: number) {
    super(TOURNAMENT_ID, {} as GameServer, GENERATION, deadline);
  }

  activate(): void {
    (
      this as unknown as { lifecycleEpoch: { begin(): TournamentLifecycleToken } }
    ).lifecycleEpoch.begin();
    this.running = true;
    (
      this as unknown as {
        armTournamentLeaseExpiryTimer(): void;
      }
    ).armTournamentLeaseExpiryTimer();
  }

  rawRunning(): boolean {
    return this.running;
  }

  authorityIsCurrent(): boolean {
    return this.hasCurrentTournamentLeaseAuthority();
  }

  async mutationAfter(gate: Promise<void>, mutate: () => void): Promise<void> {
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle) return;
    await gate;
    this.assertLifecycleCurrent(lifecycle);
    mutate();
  }

  protected override startEliminationChecker(): void {}

  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

afterEach(() => {
  _setTournamentLeaseMonotonicNowForTests();
  _setEngineLeaseMonotonicNowForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tournament lease proof deadline', () => {
  it('refuses a late renewal before an overdue expiry timer has run', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const manager = new LeaseDeadlineHarness(20_000);
    manager.activate();
    now = 20_001;
    expect(manager.renewTournamentLeaseProof(GENERATION, 25_000)).toBe(false);
    expect(manager.authorityIsCurrent()).toBe(false);
    expect(manager.rawRunning()).toBe(false);
    await manager.stop();
  });

  it('fail-stops the manager at its conservative monotonic deadline', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const manager = new LeaseDeadlineHarness(20_000);
    manager.activate();

    now = 19_999;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(manager.rawRunning()).toBe(true);

    now = 20_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.rawRunning()).toBe(false);
    await manager.stop();
  });

  it('re-arms only for the same generation before authority expires', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const manager = new LeaseDeadlineHarness(20_000);
    manager.activate();

    now = 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.renewTournamentLeaseProof(GENERATION, 25_000)).toBe(true);
    expect(manager.renewTournamentLeaseProof('bbbbbbbb-0000-4000-8000-000000000099', 30_000)).toBe(
      false
    );

    now = 20_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(manager.rawRunning()).toBe(true);

    now = 25_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.rawRunning()).toBe(false);
    await manager.stop();
  });

  it('fences a delayed continuation before its timer callback gets CPU time', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const manager = new LeaseDeadlineHarness(20_000);
    manager.activate();
    const gate = deferred();
    const mutation = vi.fn();
    const continuation = manager.mutationAfter(gate.promise, mutation);

    /* Model an event-loop stall: monotonic time crossed the deadline, but the
       fake timer has deliberately not been advanced yet. The post-await
       lifecycle assertion must be the fence. */
    now = 20_001;
    gate.resolve();
    await expect(continuation).rejects.toMatchObject({ name: 'TournamentLifecycleAbortedError' });
    expect(mutation).not.toHaveBeenCalled();
    expect(manager.rawRunning()).toBe(false);
    await manager.stop();
  });

  it('keeps the exact manager generation alive throughout a shutdown drain longer than 20s', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const manager = new LeaseDeadlineHarness(20_000);
    manager.activate();

    now = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    manager.beginServerShutdownDrain();
    expect(manager.rawRunning()).toBe(false);

    for (const renewedAt of [5_000, 10_000, 15_000, 20_000, 25_000]) {
      await vi.advanceTimersByTimeAsync(renewedAt - now);
      now = renewedAt;
      expect(manager.renewTournamentLeaseProof(GENERATION, renewedAt + 20_000)).toBe(true);
      expect(manager.authorityIsCurrent()).toBe(true);
    }

    manager.fenceForServerShutdown();
    expect(manager.renewTournamentLeaseProof(GENERATION, 50_000)).toBe(false);
    await manager.stop();
  });

  it('never shortens proof when concurrent heartbeat responses complete out of order', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const manager = new LeaseDeadlineHarness(20_000);
    manager.activate();

    now = 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.renewTournamentLeaseProof(GENERATION, 30_000)).toBe(true);
    expect(manager.renewTournamentLeaseProof(GENERATION, 25_000)).toBe(true);

    now = 25_001;
    await vi.advanceTimersByTimeAsync(20_001);
    expect(manager.authorityIsCurrent()).toBe(true);
    await manager.stop();
  });
});

const RETIRED_TABLE = 'cccccccc-0000-4000-8000-000000000001';
const HEALTHY_TABLE = 'cccccccc-0000-4000-8000-000000000002';
const proof = (
  deadline: number
): Extract<EngineLeaseAuthority, { scope: 'tournament'; verified: true }> => ({
  scope: 'tournament',
  verified: true,
  generation: GENERATION,
  tournamentId: TOURNAMENT_ID,
  proofDeadlineMonotonicMs: deadline,
});
class ConnectedDealer extends ServerTableEngine {
  activate(): void {
    expect((this as unknown as { claimProcessOwnership(): boolean }).claimProcessOwnership()).toBe(
      true
    );
    this.running = true;
  }
  reserve(): Promise<void> {
    return this.reserveF06Hand(1);
  }
  holdSettlement(pending: Promise<void>): void {
    this.trackSettlementInFlight(pending);
  }
  holdRead(pending: Promise<void>): Promise<void> {
    return this.runOwnedReadContinuation(() => pending);
  }
  holdSeatBoundary(): Promise<() => void> {
    return this.acquireSeatBoundary();
  }
}
class ConnectedManager extends TournamentManager {
  activate(engines: [string, ServerTableEngine][]): void {
    (
      this as unknown as { lifecycleEpoch: { begin(): TournamentLifecycleToken } }
    ).lifecycleEpoch.begin();
    this.running = true;
    for (const [id, engine] of engines) this.tableEngines.set(id, engine);
  }
  retain(engine: ServerTableEngine): void {
    expect(
      this.retainTournamentBreakSource(
        'dddddddd-0000-4000-8000-000000000001',
        RETIRED_TABLE,
        engine
      )
    ).toBe(true);
  }
}
async function connectedRenewal(authority: EngineLeaseAuthority = proof(10_000)) {
  vi.useFakeTimers();
  let now = 0;
  _setTournamentLeaseMonotonicNowForTests(() => now);
  _setEngineLeaseMonotonicNowForTests(() => now);
  const retired = new ConnectedDealer(RETIRED_TABLE, authority);
  const healthy = new ConnectedDealer(HEALTHY_TABLE, proof(20_000));
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'begin reply lost' } }));
  const permit = new F06HandPermit(
    {
      tournament_id: TOURNAMENT_ID,
      lease_generation: GENERATION,
      table_id: RETIRED_TABLE,
      lifecycle: '1',
      permit_id: 'dddddddd-0000-4000-8000-000000000002',
      hand_number: '1',
      custody_id: 'dddddddd-0000-4000-8000-000000000003',
    },
    rpc,
    () => true
  );
  retired.installF06HandAdmission(() => permit);
  retired.activate();
  healthy.activate();
  await expect(retired.reserve()).rejects.toThrow('f06_permit_unproven');
  const engines: [string, ServerTableEngine][] = [
    [RETIRED_TABLE, retired],
    [HEALTHY_TABLE, healthy],
  ];
  const server = Object.assign(Object.create(GameServer.prototype), {
    tableEngines: new Map(engines),
    tournamentOwnedTables: new Set(engines.map(([id]) => id)),
  }) as GameServer;
  const manager = new ConnectedManager(TOURNAMENT_ID, server, GENERATION, 20_000);
  manager.activate(engines);
  manager.retain(retired);
  return {
    retired,
    healthy,
    manager,
    server,
    rpc,
    advance: (value: number) => {
      now = value;
    },
    cleanup: async () => {
      manager.fenceForServerShutdown();
      await Promise.allSettled([retired.stop(), healthy.stop()]);
    },
  };
}
describe('connected tournament renewal with a retained F06 dealer', () => {
  it('renews the healthy manager and peer without reviving a drained retired dealer', async () => {
    const f = await connectedRenewal();
    try {
      await f.retired.stop();
      const retained = f.retired.getF06RetainedPermit();
      const renewal = vi.spyOn(f.retired, 'renewEngineLeaseProof');
      const stoppedProof = f.retired.getEngineLeaseAuthority();
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(true);
      expect(f.manager.isRunning()).toBe(true);
      expect(f.healthy.isRunning()).toBe(true);
      expect(f.healthy.getEngineLeaseAuthority()).toMatchObject({
        proofDeadlineMonotonicMs: 35_000,
      });
      expect(renewal).not.toHaveBeenCalled();
      expect(f.retired.getEngineLeaseAuthority()).toEqual(stoppedProof);
      expect(f.retired.isRunning()).toBe(false);
      expect(f.retired.hasReleasedProcessOwnership()).toBe(true);
      expect(f.retired.getF06RetainedPermit()).toEqual(retained);
      expect(f.rpc).toHaveBeenCalledTimes(1);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 40_000)).toBe(true);
      expect(f.retired.getEngineLeaseAuthority()).toEqual(stoppedProof);
      await expect(f.retired.start()).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    'active',
    'terminal without teardown',
    'settlement',
    'read continuation',
    'seat boundary',
  ] as const)(
    'still fences the manager when the expired dealer has %s ownership',
    async (state) => {
      const f = await connectedRenewal();
      const gate = deferred();
      let releaseSeat: (() => void) | undefined;
      let stopped: Promise<void> | undefined;
      let read: Promise<void> | undefined;
      try {
        if (state === 'terminal without teardown')
          f.retired.fenceForEngineLeaseLoss('test_fence', false);
        if (state === 'settlement') f.retired.holdSettlement(gate.promise);
        if (state === 'read continuation') read = f.retired.holdRead(gate.promise);
        if (state === 'seat boundary') releaseSeat = await f.retired.holdSeatBoundary();
        if (['settlement', 'read continuation', 'seat boundary'].includes(state))
          stopped = f.retired.stop();
        f.advance(15_000);
        expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
        expect(f.manager.isRunning()).toBe(false);
        expect(f.healthy.isRunning()).toBe(false);
        expect(f.retired.getEngineLeaseAuthority()).toMatchObject({
          proofDeadlineMonotonicMs: 10_000,
        });
      } finally {
        gate.resolve();
        releaseSeat?.();
        await Promise.all([stopped, read]);
        await f.cleanup();
      }
    }
  );

  it('does not certify a failed teardown even after physical ownership was released', async () => {
    const f = await connectedRenewal();
    try {
      vi.spyOn(
        f.retired as unknown as { flushSnapshot(force: boolean): Promise<void> },
        'flushSnapshot'
      ).mockRejectedValueOnce(new Error('snapshot write failed'));
      await expect(f.retired.stop()).rejects.toThrow('teardown failed');
      expect(f.retired.hasReleasedProcessOwnership()).toBe(true);
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
      expect(f.healthy.isRunning()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    [
      'scope',
      { scope: 'cash', verified: true, generation: GENERATION, proofDeadlineMonotonicMs: 10_000 },
    ],
    ['generation', { ...proof(10_000), generation: 'bbbbbbbb-0000-4000-8000-000000000099' }],
    ['tournament', { ...proof(10_000), tournamentId: 'aaaaaaaa-0000-4000-8000-000000000099' }],
    [
      'unverified authority',
      {
        scope: 'tournament',
        verified: false,
        generation: null,
        tournamentId: TOURNAMENT_ID,
        proofDeadlineMonotonicMs: null,
      },
    ],
  ] as const)('refuses retired %s mismatch', async (_label, authority) => {
    const f = await connectedRenewal(authority);
    try {
      await f.retired.stop();
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
      expect(f.healthy.isRunning()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it.each(['server registry', 'process registry'] as const)(
    'refuses a retired object with changed %s ownership',
    async (registry) => {
      const f = await connectedRenewal();
      const replacement = new ConnectedDealer(RETIRED_TABLE, proof(30_000));
      try {
        await f.retired.stop();
        if (registry === 'process registry') replacement.activate();
        else
          (
            f.server as unknown as { tableEngines: Map<string, ServerTableEngine> }
          ).tableEngines.set(RETIRED_TABLE, replacement);
        f.advance(15_000);
        expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
        expect(f.healthy.isRunning()).toBe(false);
      } finally {
        await replacement.stop();
        await f.cleanup();
      }
    }
  );

  it('does not use a retired child to resurrect an expired manager', async () => {
    const f = await connectedRenewal();
    try {
      await f.retired.stop();
      f.advance(20_001);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 40_000)).toBe(false);
      expect(f.manager.isRunning()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it('rechecks new owned work on an already stopped quarantine without extending its proof', async () => {
    const f = await connectedRenewal();
    const gate = deferred();
    let read: Promise<void> | undefined;
    try {
      await f.retired.stop();
      read = f.retired.holdRead(gate.promise);
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
      expect(f.retired.getEngineLeaseAuthority()).toMatchObject({
        proofDeadlineMonotonicMs: 10_000,
      });
    } finally {
      gate.resolve();
      await read;
      await f.cleanup();
    }
  });

  it('binds the completed teardown to its exact table identity', async () => {
    const f = await connectedRenewal();
    try {
      await f.retired.stop();
      f.advance(15_000);
      expect(f.retired.isTerminalDrainedForTournamentLease(HEALTHY_TABLE, proof(35_000))).toBe(
        false
      );
      expect(f.retired.isTerminalDrainedForTournamentLease(RETIRED_TABLE, proof(35_000))).toBe(
        true
      );
    } finally {
      await f.cleanup();
    }
  });
});
