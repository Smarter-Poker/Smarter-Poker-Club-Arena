import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentEliminationScheduler } from './TournamentEliminationScheduler.js';

/**
 * 2026-09-10, 20:13 and again at 20:57 UTC: the engine died with
 * "RangeError: Maximum call stack size exceeded" (an unhandled rejection),
 * right after a burst of 352 "self-terminating for restart:
 * tournament_lease_lost" kills - one table from each of ~350 different
 * tournaments, with no "Tournament.lease_proof_expired" report between them.
 *
 * The chain was a recursion through this scheduler. pump() asks the next
 * queued manager isActive(). A manager answers with lifecycleIsCurrent(),
 * which - when its lease proof has already expired - fences its tables,
 * applies the stop fence and unregisters from the scheduler, and the
 * unregister closure called pump() again. From INSIDE the first pump. That
 * nested pump asked the next dead manager, which unregistered, which
 * pumped... one nested pump per dead manager, until the stack ran out.
 * A lease storm is exactly when hundreds of queued managers are dead at once.
 *
 * The law: nothing the scheduler calls can recurse the scheduler. A pump
 * requested while one is running is folded into the running one.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** Deep enough that one stack frame per dead manager could never fit. */
const DEAD_MANAGERS = 5_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface DeadManagers {
  scheduler: TournamentEliminationScheduler;
  releaseTheSlot: () => void;
  kill: () => void;
  ran: string[];
}

/**
 * One slot, held by a sweep that is still running, and DEAD_MANAGERS queued
 * behind it. Each queued manager behaves exactly like TournamentManagerBase:
 * once its lease is gone, isActive() tears it down - which unregisters it -
 * and then answers false.
 */
function queueDeadManagersBehindOneRunningSweep(): DeadManagers {
  const scheduler = new TournamentEliminationScheduler({
    maxConcurrent: 1,
    sweepWarnMs: 0,
    startTimers: false,
  });
  let releaseTheSlot!: () => void;
  scheduler.register({
    tournamentId: 'the-running-sweep',
    run: () => new Promise<void>((resolve) => (releaseTheSlot = resolve)),
  });

  const ran: string[] = [];
  let leasesLost = false;
  for (let i = 0; i < DEAD_MANAGERS; i++) {
    const tournamentId = `dead-${i}`;
    let unregister: () => void = () => undefined;
    unregister = scheduler.register({
      tournamentId,
      run: async () => void ran.push(tournamentId),
      isActive: () => {
        if (!leasesLost) return true;
        // lifecycleIsCurrent() -> expireTournamentLeaseAuthority() ->
        // fenceForTournamentLeaseLoss() -> applyStopFence() ->
        // unregisterEliminationScheduler()
        unregister();
        return false;
      },
    });
  }
  return {
    scheduler,
    releaseTheSlot: () => releaseTheSlot(),
    kill: () => (leasesLost = true),
    ran,
  };
}

describe('a dead manager cannot recurse the elimination scheduler', () => {
  it('drains hundreds of managers that lose their leases together, flat, without overflowing the stack', async () => {
    const { scheduler, releaseTheSlot, kill, ran } = queueDeadManagersBehindOneRunningSweep();
    await flush();
    expect(scheduler.snapshot()).toMatchObject({ running: 1, queued: DEAD_MANAGERS });

    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      kill();
      // The running sweep settles -> finish() -> pump(), which walks the dead.
      releaseTheSlot();
      await flush();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(unhandled).toEqual([]);
    expect(ran).toEqual([]);
    // Every dead manager is gone; only the one whose sweep held the slot is left.
    expect(scheduler.snapshot()).toMatchObject({ registered: 1, queued: 0, running: 0 });
    scheduler.stop();
  });

  it('still dispatches a live manager queued behind the dead ones in the same pass', async () => {
    const { scheduler, releaseTheSlot, kill, ran } = queueDeadManagersBehindOneRunningSweep();
    scheduler.register({ tournamentId: 'alive', run: async () => void ran.push('alive') });
    await flush();

    kill();
    releaseTheSlot();
    await flush();

    expect(ran).toEqual(['alive']);
    // The running sweep's manager and the live one; not one dead manager left.
    expect(scheduler.snapshot()).toMatchObject({ registered: 2, queued: 0 });
    scheduler.stop();
  });

  it('holds on the delayed-wake path too, where one timer enqueues a due batch and walks it', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const ran: string[] = [];
    // Quiet at registration (no admission sweep to drain), alive while the
    // wakes are armed, and dying in the moment between the timer enqueueing
    // the batch and the pump walking it - a lease deadline crossed mid-batch.
    let phase: 'registering' | 'alive' | 'dying' = 'registering';
    for (let i = 0; i < DEAD_MANAGERS; i++) {
      const tournamentId = `dead-${i}`;
      let answersWhileDying = 0;
      let unregister: () => void = () => undefined;
      unregister = scheduler.register({
        tournamentId,
        run: async () => void ran.push(tournamentId),
        isActive: () => {
          if (phase === 'registering') return false;
          if (phase === 'alive' || answersWhileDying++ === 0) return true;
          unregister();
          return false;
        },
      });
    }
    phase = 'alive';
    for (let i = 0; i < DEAD_MANAGERS; i++) scheduler.wakeAfter(`dead-${i}`, 1_000);
    expect(scheduler.snapshot()).toMatchObject({
      registered: DEAD_MANAGERS,
      pendingWakes: DEAD_MANAGERS,
    });

    phase = 'dying';
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    await flush();

    expect(ran).toEqual([]);
    expect(scheduler.snapshot()).toMatchObject({ registered: 0, queued: 0, running: 0 });
    scheduler.stop();
  });

  it('a manager that dies while the due batch is being enqueued cannot pump the batch half-built', async () => {
    // 2026-09-11. The case above dies inside pump(), after the whole batch is
    // queued. This one dies on its FIRST isActive() call - the one enqueue()
    // makes while the timer is still building the batch. Its unregister
    // closure pumped right there, outside any pump pass, and the routine sweep
    // queued before it took the only slot while the urgent sweep due in the
    // same firing had not been enqueued yet: R ran before U. Urgent goes first.
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const ran: string[] = [];
    let leaseLost = false;
    scheduler.register({ tournamentId: 'R', run: async () => void ran.push('R') });
    let unregisterDying: () => void = () => undefined;
    unregisterDying = scheduler.register({
      tournamentId: 'D',
      run: async () => void ran.push('D'),
      isActive: () => {
        if (!leaseLost) return true;
        unregisterDying(); // lifecycleIsCurrent() -> ... -> unregisterEliminationScheduler()
        return false;
      },
    });
    scheduler.register({ tournamentId: 'U', run: async () => void ran.push('U') });
    for (let turn = 0; turn < 20 && ran.length < 3; turn++) await flush();
    expect(ran).toEqual(['R', 'D', 'U']); // the three admission sweeps
    ran.length = 0;

    // All due in one firing, in this order: routine R, routine D, urgent U.
    scheduler.wakeAfter('R', 1_000);
    scheduler.wakeAfter('D', 1_000);
    scheduler.wakeUrgentAfter('U', 1_000);
    leaseLost = true;
    vi.advanceTimersByTime(1_000);
    for (let turn = 0; turn < 20 && ran.length < 2; turn++) await flush();

    expect(ran).toEqual(['U', 'R']);
    expect(scheduler.snapshot()).toMatchObject({ registered: 2, queued: 0 });
    scheduler.stop();
  });
});
