import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setTournamentLeaseMonotonicNowForTests } from '../services/tournamentLease.js';
import type { GameServer } from '../GameServer.js';
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tournament lease proof deadline', () => {
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
