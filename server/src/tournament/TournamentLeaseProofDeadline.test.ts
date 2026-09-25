import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setTournamentLeaseMonotonicNowForTests } from '../services/tournamentLease.js';
import { GameServer } from '../GameServer.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import {
  _setEngineLeaseMonotonicNowForTests,
  type EngineLeaseAuthority,
} from '../engine/ServerTableEngineBase.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
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
  pauseAtMovementBoundary(): void {
    this.handForHandResolve = () => undefined;
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
  /** The production wiring: a fenced dealer signals this manager to replace it. */
  wire(engine: ServerTableEngine): void {
    this.wireEliminationWake(engine);
  }
  replacing(tableId: string, engine: ServerTableEngine): boolean {
    return (
      this as unknown as {
        isReplacingManagedTableEngine(tableId: string, engine: ServerTableEngine): boolean;
      }
    ).isReplacingManagedTableEngine(tableId, engine);
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
  const rpc = vi.fn(
    async (): Promise<{ data: unknown; error: { message: string } | null }> => ({
      data: null,
      error: { message: 'begin reply lost' },
    })
  );
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
  it.each(['revalidation', 'move RPC', 'failed move RPC'] as const)(
    'keeps a live manager lease while its stopped F06 source awaits %s',
    async (phase) => {
      vi.useFakeTimers();
      let now = 0;
      _setTournamentLeaseMonotonicNowForTests(() => now);
      _setEngineLeaseMonotonicNowForTests(() => now);
      const retired = new ConnectedDealer(RETIRED_TABLE, proof(10_000));
      const healthy = new ConnectedDealer(HEALTHY_TABLE, proof(20_000));
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
      const owner = 'dddddddd-0000-4000-8000-000000000011';
      const revalidation = deferred();
      const validate = vi.fn(() =>
        phase === 'revalidation' ? revalidation.promise : Promise.resolve()
      );
      retired.installF06MovementAdmission(
        owner,
        {
          admission_id: 'dddddddd-0000-4000-8000-000000000012',
          tournament_id: TOURNAMENT_ID,
          lease_generation: GENERATION,
          table_id: RETIRED_TABLE,
          lifecycle: '1',
          break_id: 'dddddddd-0000-4000-8000-000000000013',
          custody_id: 'dddddddd-0000-4000-8000-000000000014',
          revision: '1',
          proof_hash: 'a'.repeat(64),
        },
        () => manager.isRunning() && server.ownsTournamentTableEngine(RETIRED_TABLE, retired),
        validate
      );
      retired.activate();
      retired.pauseAtMovementBoundary();
      healthy.activate();
      expect(await retired.parkForTournamentMove(owner, 0)).toBe(true);
      await retired.stop();
      const stoppedProof = retired.getEngineLeaseAuthority();
      now = 15_000;
      const operation = vi.fn(async () => {
        if (phase !== 'revalidation') await revalidation.promise;
        if (phase === 'failed move RPC') throw new Error('move receipt unknown');
        return 'exact move receipt';
      });
      const move = retired.executeTournamentMoveAtBoundary(owner, operation);
      void move.catch(() => undefined);
      await Promise.resolve();
      try {
        expect(validate).toHaveBeenCalledOnce();
        expect(operation).toHaveBeenCalledTimes(phase === 'revalidation' ? 0 : 1);
        expect(retired.isTerminalDrainedForTournamentLease(RETIRED_TABLE, proof(35_000))).toBe(
          false
        );
        expect(manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(true);
        expect(manager.isRunning()).toBe(true);
        expect(healthy.getEngineLeaseAuthority()).toMatchObject({
          proofDeadlineMonotonicMs: 35_000,
        });
        expect(retired.getEngineLeaseAuthority()).toEqual(stoppedProof);
        revalidation.resolve();
        if (phase === 'failed move RPC') await expect(move).rejects.toThrow('move receipt unknown');
        else await expect(move).resolves.toBe('exact move receipt');
        expect(operation).toHaveBeenCalledOnce();
        expect(retired.isTerminalF06MovementForTournamentLease(RETIRED_TABLE, proof(35_000))).toBe(
          false
        );
        expect(retired.isTerminalDrainedForTournamentLease(RETIRED_TABLE, proof(35_000))).toBe(
          true
        );
        expect(manager.isRunning()).toBe(true);
        expect(retired.isRunning()).toBe(false);
        await expect(retired.start()).rejects.toThrow();
      } finally {
        revalidation.resolve();
        await move.catch(() => undefined);
        manager.fenceForServerShutdown();
        await Promise.allSettled([retired.stop(), healthy.stop()]);
      }
    }
  );

  it('keeps a live manager lease during an original no-start custody move', async () => {
    const f = await connectedRenewal();
    const registry = new TournamentRetirementCustody<ServerTableEngine>();
    const binding = {
      breakId: 'dddddddd-0000-4000-8000-000000000001',
      tableId: RETIRED_TABLE,
      tableIncarnation: '1',
      tournamentId: TOURNAMENT_ID,
      custodyId: 'dddddddd-0000-4000-8000-000000000021',
      durableRevision: '1',
      leaseGeneration: GENERATION,
    };
    const hand = f.retired.getF06RetainedPermit()!.binding;
    f.rpc.mockResolvedValue({
      data: {
        ok: true,
        ...hand,
        generation: GENERATION,
        evidence_id: binding.custodyId,
        state: 'never_started',
      },
      error: null,
    });
    const global = (f.server as unknown as { tableEngines: Map<string, ServerTableEngine> })
      .tableEngines;
    const local = (f.manager as unknown as { tableEngines: Map<string, ServerTableEngine> })
      .tableEngines;
    const owner = 'dddddddd-0000-4000-8000-000000000022';
    try {
      await registry.withCustody(
        binding,
        global,
        local,
        () => f.manager.isRunning(),
        async (custody) => {
          await f.retired.admitF06StoppedOriginalMovement(owner, custody, async () => ({
            ok: true,
            state: 'park_requested',
            break_id: binding.breakId,
            custody_id: binding.custodyId,
            revision: binding.durableRevision,
            custody_generation: GENERATION,
            tournament_id: TOURNAMENT_ID,
            source_table_id: RETIRED_TABLE,
            lifecycle: '1',
          }));
          const stoppedProof = f.retired.getEngineLeaseAuthority();
          f.advance(15_000);
          const gate = deferred();
          const move = f.retired.executeTournamentMoveAtBoundary(owner, () => gate.promise);
          void move.catch(() => undefined);
          try {
            expect(
              f.retired.isTerminalDrainedForTournamentLease(RETIRED_TABLE, proof(35_000))
            ).toBe(false);
            expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(true);
            expect(f.retired.getEngineLeaseAuthority()).toEqual(stoppedProof);
            expect(f.retired.getF06RetainedPermit()).toBeNull();
          } finally {
            gate.resolve();
            await move;
          }
        },
        async () => {}
      );
      expect(f.manager.isRunning()).toBe(true);
      expect(f.retired.isTerminalF06MovementForTournamentLease(RETIRED_TABLE, proof(35_000))).toBe(
        false
      );
      await expect(
        f.retired.executeTournamentMoveAtBoundary(owner, async () => {})
      ).rejects.toThrow('stale');
    } finally {
      await f.cleanup();
    }
  });

  it('does not treat an ordinary stopped move as an admitted F06 replay', async () => {
    const f = await connectedRenewal();
    const gate = deferred();
    let move: Promise<void> | undefined;
    try {
      f.retired.pauseAtMovementBoundary();
      expect(await f.retired.parkForTournamentMove('ordinary-owner', 0)).toBe(true);
      await f.retired.stop();
      f.advance(15_000);
      move = f.retired.executeTournamentMoveAtBoundary('ordinary-owner', () => gate.promise);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
      expect(f.manager.isRunning()).toBe(false);
      expect(f.retired.getEngineLeaseAuthority()).toMatchObject({
        proofDeadlineMonotonicMs: 10_000,
      });
    } finally {
      gate.resolve();
      await move;
      await f.cleanup();
    }
  });

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

/**
 * ONE ZOMBIE TABLE DOES NOT FENCE ITS TOURNAMENT (2026-09-25, release
 * 778075b4). The zombie watchdog kills one tournament table with
 * `fenceForEngineLeaseLoss('tournament_table_zombie', true)`; the fence
 * expires that dealer's proof and signals the manager, whose replacement
 * stops it. Until that stop settles the dealer is terminal but not drained,
 * and the manager's renewal pass used to ask it to renew, take the refusal
 * as a lost tournament lease, and fence every sibling: two single-table
 * kills at 19:54:05 and 20:15:20 UTC quarantined 17 managers.
 */
describe('connected tournament renewal while one zombie-killed dealer is being replaced', () => {
  const ZOMBIE_TABLE = 'cccccccc-0000-4000-8000-000000000003';
  const SIBLING_TABLE = 'cccccccc-0000-4000-8000-000000000004';

  async function zombieRenewal(siblingDeadline = 20_000) {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    _setEngineLeaseMonotonicNowForTests(() => now);
    const zombie = new ConnectedDealer(ZOMBIE_TABLE, proof(20_000));
    const sibling = new ConnectedDealer(SIBLING_TABLE, proof(siblingDeadline));
    const engines: [string, ServerTableEngine][] = [
      [ZOMBIE_TABLE, zombie],
      [SIBLING_TABLE, sibling],
    ];
    const server = Object.assign(Object.create(GameServer.prototype), {
      tableEngines: new Map(engines),
      tournamentOwnedTables: new Set(engines.map(([id]) => id)),
    }) as GameServer;
    const manager = new ConnectedManager(TOURNAMENT_ID, server, GENERATION, 20_000);
    manager.activate(engines);
    manager.wire(zombie);
    manager.wire(sibling);
    zombie.activate();
    sibling.activate();
    return {
      zombie,
      sibling,
      manager,
      advance: (value: number) => {
        now = value;
      },
      cleanup: async () => {
        manager.fenceForServerShutdown();
        await Promise.allSettled([zombie.stop(), sibling.stop()]);
      },
    };
  }

  it('keeps the manager lease and the sibling dealing while the zombie stop is in flight', async () => {
    const f = await zombieRenewal();
    const gate = deferred();
    try {
      // The zombie's stop cannot settle until this owned writer does.
      f.zombie.holdSettlement(gate.promise);
      // The exact watchdog call (GameServer.zombie_engine_rebuilt, tournament branch).
      f.zombie.fenceForEngineLeaseLoss('tournament_table_zombie', true);
      expect(f.zombie.isRunning()).toBe(false);
      // The restart signal is a microtask; the replacement is registered before
      // its first await.
      await Promise.resolve();
      await Promise.resolve();
      expect(f.manager.replacing(ZOMBIE_TABLE, f.zombie)).toBe(true);
      expect(f.zombie.isTerminalDrainedForTournamentLease(ZOMBIE_TABLE, proof(35_000))).toBe(false);
      expect(f.zombie.isTerminalFencedForTournamentLease(ZOMBIE_TABLE, proof(35_000))).toBe(true);
      const zombieRenewal = vi.spyOn(f.zombie, 'renewEngineLeaseProof');
      const zombieProof = f.zombie.getEngineLeaseAuthority();

      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(true);
      expect(f.manager.isRunning()).toBe(true);
      expect(f.sibling.isRunning()).toBe(true);
      expect(f.sibling.getEngineLeaseAuthority()).toMatchObject({
        proofDeadlineMonotonicMs: 35_000,
      });
      // The zombie was neither asked to renew nor revived.
      expect(zombieRenewal).not.toHaveBeenCalled();
      expect(f.zombie.getEngineLeaseAuthority()).toEqual(zombieProof);
      expect(f.zombie.isRunning()).toBe(false);
      // A second pass, still in flight, still holds.
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 40_000)).toBe(true);
      expect(f.manager.isRunning()).toBe(true);
    } finally {
      gate.resolve();
      await f.cleanup();
    }
  });

  it('keeps the manager lease while the replacement is booked for a retry after a failed stop', async () => {
    const f = await zombieRenewal();
    try {
      // A stop that rejects before the process fence is released is the shape
      // the recovery books a retry for, naming this exact generation.
      vi.spyOn(f.zombie, 'stop').mockRejectedValueOnce(new Error('stop reply lost'));
      f.zombie.fenceForEngineLeaseLoss('tournament_table_zombie', true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.manager.replacing(ZOMBIE_TABLE, f.zombie)).toBe(true);
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(true);
      expect(f.manager.isRunning()).toBe(true);
      expect(f.sibling.isRunning()).toBe(true);
      expect(f.sibling.getEngineLeaseAuthority()).toMatchObject({
        proofDeadlineMonotonicMs: 35_000,
      });
    } finally {
      await f.cleanup();
    }
  });

  it('still fences the tournament for a fenced dealer that nobody is replacing', async () => {
    const f = await zombieRenewal();
    const gate = deferred();
    try {
      f.zombie.holdSettlement(gate.promise);
      // The same fence without the owner signal: no replacement is registered.
      f.zombie.fenceForEngineLeaseLoss('tournament_table_zombie', false);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.manager.replacing(ZOMBIE_TABLE, f.zombie)).toBe(false);
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
      expect(f.manager.isRunning()).toBe(false);
      expect(f.sibling.isRunning()).toBe(false);
    } finally {
      gate.resolve();
      await f.cleanup();
    }
  });

  it('still fences the tournament when a live sibling truly cannot renew', async () => {
    // The sibling's own proof lapsed at 10s; at 15s it is a live dealer that
    // cannot be renewed, and that is a lost lease whatever the zombie is doing.
    const f = await zombieRenewal(10_000);
    const gate = deferred();
    try {
      f.zombie.holdSettlement(gate.promise);
      f.zombie.fenceForEngineLeaseLoss('tournament_table_zombie', true);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.manager.replacing(ZOMBIE_TABLE, f.zombie)).toBe(true);
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
      expect(f.manager.isRunning()).toBe(false);
      expect(f.sibling.isRunning()).toBe(false);
    } finally {
      gate.resolve();
      await f.cleanup();
    }
  });

  it('still fences the tournament when the replaced dealer has lost server ownership', async () => {
    const f = await zombieRenewal();
    const gate = deferred();
    const stranger = new ConnectedDealer(ZOMBIE_TABLE, proof(30_000));
    try {
      f.zombie.holdSettlement(gate.promise);
      f.zombie.fenceForEngineLeaseLoss('tournament_table_zombie', true);
      await Promise.resolve();
      await Promise.resolve();
      (
        f.manager as unknown as { gameServer: { tableEngines: Map<string, ServerTableEngine> } }
      ).gameServer.tableEngines.set(ZOMBIE_TABLE, stranger);
      f.advance(15_000);
      expect(f.manager.renewTournamentLeaseProof(GENERATION, 35_000)).toBe(false);
      expect(f.sibling.isRunning()).toBe(false);
    } finally {
      gate.resolve();
      await stranger.stop();
      await f.cleanup();
    }
  });
});
