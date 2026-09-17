import { afterEach, describe, expect, it, vi } from 'vitest';
import { alwaysOnRegistry } from '../observability/engineInstruments.js';
import {
  TournamentEliminationScheduler,
  DEFAULT_MAX_CONCURRENT_SWEEPS,
} from './TournamentEliminationScheduler.js';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TournamentEliminationScheduler', () => {
  it('load-gates hundreds of managers through one FIFO and never exceeds the global cap', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: DEFAULT_MAX_CONCURRENT_SWEEPS,
      sweepWarnMs: 0,
    });
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    let completed = 0;

    for (let i = 0; i < 320; i++) {
      scheduler.register({
        tournamentId: `t-${i.toString().padStart(3, '0')}`,
        run: async () => {
          started.push(i);
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
          completed++;
        },
      });
    }

    await vi.waitFor(() => expect(completed).toBe(320));
    expect(maxActive).toBe(DEFAULT_MAX_CONCURRENT_SWEEPS);
    expect(started).toEqual(Array.from({ length: 320 }, (_, i) => i));
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0, registered: 320 });

    // Metrics freshness is the only process interval, independent of the 320
    // registrations. Correctness is driven by events and explicit deadlines.
    const schedulerIntervals = intervalSpy.mock.calls.filter(([, ms]) => ms === 1_000);
    expect(schedulerIntervals).toHaveLength(1);
    expect(intervalSpy.mock.calls.some(([, ms]) => ms === 120_000)).toBe(false);
    scheduler.stop();
  });

  it('deduplicates a hot tournament and guarantees routine causal work after an urgent burst', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      eventWakeDelayMs: 0,
      sweepWarnMs: 0,
      urgentBurst: 3,
      startTimers: false,
    });
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const run = (id: string) => async () => {
      order.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
    };

    scheduler.register({ tournamentId: 'hot', run: run('hot') });
    scheduler.register({ tournamentId: 'safety-peer', run: run('safety-peer') });
    await flush();

    for (let cycle = 0; cycle < 3; cycle++) {
      scheduler.wake('hot');
      scheduler.wake('hot');
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.shift()!();
      await flush();
    }

    expect(order.slice(0, 4)).toEqual(['hot', 'hot', 'hot', 'hot']);
    releases.shift()!();
    await flush();
    expect(order[4]).toBe('safety-peer');

    releases.splice(0).forEach((release) => release());
    scheduler.stop();
  });

  it('coalesces repeated post-sync hand-complete wakes without blocking settlement', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      eventWakeDelayMs: 0,
      sweepWarnMs: 0,
      startTimers: false,
    });
    let runs = 0;
    scheduler.register({
      tournamentId: 'bust',
      run: async () => {
        runs++;
      },
    });
    await flush();
    expect(runs).toBe(1);

    scheduler.wake('bust');
    scheduler.wake('bust');
    scheduler.wake('bust');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(runs).toBe(2);
    expect(scheduler.snapshot().pendingWakes).toBe(0);
    scheduler.stop();
  });

  it('coalesces narrow delayed feature wakes on the one process timer', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    let runs = 0;
    scheduler.register({ tournamentId: 'feature', run: async () => void runs++ });
    await flush();
    expect(runs).toBe(1);

    scheduler.wakeAfter('feature', 10_000);
    scheduler.wakeAfter('feature', 10_000);
    scheduler.wakeAfter('feature', 20_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(runs).toBe(2);
    expect(scheduler.snapshot().pendingWakes).toBe(0);
    scheduler.stop();
  });

  it('dispatches overdue wakes by deadline, not manager registration order', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const order: string[] = [];
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
      now: () => clock,
    });
    scheduler.register({
      tournamentId: 'registered-first',
      run: async () => void order.push('registered-first'),
    });
    scheduler.register({
      tournamentId: 'registered-second',
      run: async () => void order.push('registered-second'),
    });
    for (let turn = 0; turn < 10 && scheduler.snapshot().running > 0; turn++) {
      await flush();
    }
    expect(scheduler.snapshot().running).toBe(0);
    order.length = 0;
    scheduler.wakeUrgentAfter('registered-first', 10_000);
    scheduler.wakeUrgentAfter('registered-second', 5_000);
    clock = 20_000; // model an event loop that wakes after both deadlines
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(order).toEqual(['registered-second', 'registered-first']);
    scheduler.stop();
  });

  it('never demotes an urgent wake when an earlier routine wake already exists', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const order: string[] = [];
    let releaseBlocker!: () => void;
    scheduler.register({
      tournamentId: 'blocker',
      run: async () => {
        order.push('blocker');
        await new Promise<void>((resolve) => (releaseBlocker = resolve));
      },
    });
    scheduler.register({
      tournamentId: 'safety-peer',
      run: async () => void order.push('safety-peer'),
    });
    scheduler.register({
      tournamentId: 'urgent-upgrade',
      run: async () => void order.push('urgent-upgrade'),
    });
    await flush();

    scheduler.wakeAfter('urgent-upgrade', 1_000);
    scheduler.wakeUrgentAfter('urgent-upgrade', 5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    releaseBlocker();
    await flush();
    expect(order.slice(0, 2)).toEqual(['blocker', 'urgent-upgrade']);
    scheduler.stop();
  });

  it('an urgent upgrade leaves no stale routine reference for a rerun to jump the queue with', async () => {
    // 2026-09-11. The upgrade used to leave A's old routine reference at the
    // head. After A's urgent sweep ran, a routine rerun queued A as routine
    // again and that old reference was valid once more: A ran twice before B
    // and C, which had been waiting all along (X, A, A, B, C). A coalesced
    // rerun belongs at the tail.
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const run = (id: string, holds: number) => {
      let calls = 0;
      return async () => {
        order.push(id);
        if (calls++ < holds) await new Promise<void>((resolve) => gates.set(id, resolve));
      };
    };
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 10; turn++) await flush();
    };

    // X holds the only slot; A, B and C wait behind it as routine.
    scheduler.register({ tournamentId: 'X', run: run('X', 1) });
    await flush();
    scheduler.register({ tournamentId: 'A', run: run('A', 1) });
    scheduler.register({ tournamentId: 'B', run: run('B', 0) });
    scheduler.register({ tournamentId: 'C', run: run('C', 0) });
    await flush();
    expect(order).toEqual(['X']);

    // A bust at A upgrades it in place, so A runs next, ahead of B and C.
    scheduler.wakeUrgentAfter('A', 0);
    await vi.advanceTimersByTimeAsync(0);
    gates.get('X')!();
    await settle();
    expect(order).toEqual(['X', 'A']);

    // While A runs, a routine feature wake marks it for one coalesced rerun.
    scheduler.wakeAfter('A', 0);
    await vi.advanceTimersByTimeAsync(0);
    gates.get('A')!();
    await settle();

    expect(order).toEqual(['X', 'A', 'B', 'C', 'A']);
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0 });
    scheduler.stop();
  });

  it('admits a delayed unresolved bust ahead of a loaded routine causal backlog', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const order: string[] = [];
    let releaseBlocker!: () => void;
    scheduler.register({
      tournamentId: 'blocker',
      run: async () => {
        order.push('blocker');
        await new Promise<void>((resolve) => (releaseBlocker = resolve));
      },
    });
    for (let i = 0; i < 200; i++) {
      scheduler.register({
        tournamentId: `routine-${i}`,
        run: async () => void order.push(`routine-${i}`),
      });
    }
    scheduler.register({
      tournamentId: 'unresolved-bust',
      run: async () => void order.push('unresolved-bust'),
    });
    scheduler.wakeUrgentAfter('unresolved-bust', 5_000);
    await flush();
    expect(order).toEqual(['blocker']);

    await vi.advanceTimersByTimeAsync(5_000);
    releaseBlocker();
    await flush();
    expect(order[1]).toBe('unresolved-bust');
    scheduler.stop();
  });

  /**
   * An urgent wake is a promotion, never a demotion (2026-09-11).
   *
   * After the 06:57 boot of c58dfafd about 350 events kept the urgent lane
   * full, and a wake for an event already waiting in the routine lane pushed
   * it onto the tail of that urgent lane, orphaning the routine place it had
   * almost reached. The oldest-wait gauge climbed from 49 s to 1,470 s while
   * routine work queued after it was served. The shape here is that
   * incident in miniature: twelve events with urgent work, one routine event
   * that has waited longest, one that arrived after it.
   */
  it('an urgent wake keeps the routine place a waiting tournament already holds', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      urgentBurst: 3,
      startTimers: false,
    });
    const order: string[] = [];
    for (let i = 0; i < 12; i++) {
      scheduler.register({
        tournamentId: `busy-${i}`,
        run: async () => void order.push(`busy-${i}`),
      });
    }
    for (
      let turn = 0;
      turn < 50 && scheduler.snapshot().queued + scheduler.snapshot().running > 0;
      turn++
    ) {
      await flush();
    }
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0 });
    order.length = 0;

    let releaseBlocker!: () => void;
    scheduler.register({
      tournamentId: 'blocker',
      run: async () => {
        order.push('blocker');
        await new Promise<void>((resolve) => (releaseBlocker = resolve));
      },
    });
    await flush();
    scheduler.register({ tournamentId: 'oldest', run: async () => void order.push('oldest') });
    scheduler.register({ tournamentId: 'newer', run: async () => void order.push('newer') });
    for (let i = 0; i < 12; i++) scheduler.wake(`busy-${i}`);
    scheduler.wake('oldest');
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.snapshot()).toMatchObject({ running: 1, queued: 14 });

    releaseBlocker();
    for (
      let turn = 0;
      turn < 50 && scheduler.snapshot().queued + scheduler.snapshot().running > 0;
      turn++
    ) {
      await flush();
    }

    // Three urgent turns, then the routine turn - which is the place 'oldest'
    // was already waiting in. It is served once, not again from the urgent tail.
    expect(order.slice(0, 5)).toEqual(['blocker', 'busy-0', 'busy-1', 'busy-2', 'oldest']);
    expect(order.indexOf('oldest')).toBeLessThan(order.indexOf('newer'));
    expect(order.filter((id) => id === 'oldest')).toHaveLength(1);
    expect(order).toHaveLength(15);
    scheduler.stop();
  });

  it('a place given up by an earlier pass never serves a later one ahead of its peers', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      urgentBurst: 3,
      startTimers: false,
    });
    const order: string[] = [];
    let releaseBlocker!: () => void;
    let releaseHot!: () => void;
    scheduler.register({
      tournamentId: 'blocker',
      run: async () => {
        order.push('blocker');
        await new Promise<void>((resolve) => (releaseBlocker = resolve));
      },
    });
    await flush();
    scheduler.register({
      tournamentId: 'hot',
      run: async () => {
        order.push('hot');
        if (order.filter((id) => id === 'hot').length === 1) {
          await new Promise<void>((resolve) => (releaseHot = resolve));
        }
      },
    });
    for (let i = 0; i < 5; i++) {
      scheduler.register({
        tournamentId: `peer-${i}`,
        run: async () => void order.push(`peer-${i}`),
      });
    }
    // Upgrade 'hot' while its routine place is at the head of the lane.
    scheduler.wake('hot');
    await vi.advanceTimersByTimeAsync(0);

    releaseBlocker();
    await flush();
    expect(order).toEqual(['blocker', 'hot']);

    // Routine follow-up work arrives while the pass runs, so the tournament is
    // queued again - at the TAIL of the routine lane, behind every peer.
    scheduler.wakeAfter('hot', 0);
    await vi.advanceTimersByTimeAsync(0);
    releaseHot();
    for (
      let turn = 0;
      turn < 50 && scheduler.snapshot().queued + scheduler.snapshot().running > 0;
      turn++
    ) {
      await flush();
    }

    expect(order).toEqual([
      'blocker',
      'hot',
      'peer-0',
      'peer-1',
      'peer-2',
      'peer-3',
      'peer-4',
      'hot',
    ]);
    scheduler.stop();
  });

  it('replaces a stalled slot without releasing it: real concurrency is bounded at twice the cap', async () => {
    /* A STALLED SLOT IS REPLACED, NOT RELEASED (2026-09-16). Three of four
       production slots were held by promises unresolved since 05:30, 07:33
       and 15:17 UTC; the fourth served 1,609 tournaments one at a time and
       804 decided events never reached their finish stage. A stalled promise
       still keeps its slot and its tournament stays excluded, but the cap is
       raised by one for each stalled promise, never by more than the cap. */
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 2,
      sweepWarnMs: 100,
      startTimers: false,
    });
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let actualActive = 0;
    let maxActualActive = 0;
    for (let i = 0; i < 6; i++) {
      scheduler.register({
        tournamentId: `hung-${i}`,
        run: async () => {
          started.push(`hung-${i}`);
          actualActive++;
          maxActualActive = Math.max(maxActualActive, actualActive);
          await new Promise<void>((resolve) => releases.push(resolve));
          actualActive--;
        },
      });
    }
    await flush();
    expect(started).toEqual(['hung-0', 'hung-1']);
    expect(scheduler.snapshot()).toMatchObject({ running: 2, queued: 4, stalled: 0 });

    // The first two stall past the warning budget: two compensating slots open.
    await vi.advanceTimersByTimeAsync(101);
    await flush();
    expect(started).toEqual(['hung-0', 'hung-1', 'hung-2', 'hung-3']);
    expect(scheduler.snapshot()).toMatchObject({ running: 4, queued: 2, stalled: 2 });

    // Those stall too. Four stalled promises may open only two compensating
    // slots (the cap), so nothing else is dispatched: real concurrency never
    // exceeds twice the cap, whatever the number of stalls.
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(started).toEqual(['hung-0', 'hung-1', 'hung-2', 'hung-3']);
    expect(scheduler.snapshot()).toMatchObject({ running: 4, queued: 2, stalled: 4 });
    expect(maxActualActive).toBe(4);

    // A stalled promise settling gives its slot back exactly once.
    releases.shift()!();
    await flush();
    expect(started).toEqual(['hung-0', 'hung-1', 'hung-2', 'hung-3', 'hung-4']);
    expect(scheduler.snapshot()).toMatchObject({ running: 4, queued: 1, stalled: 3 });
    expect(actualActive).toBe(4);
    expect(maxActualActive).toBe(4);
    scheduler.stop();
  });

  it('never dispatches the same tournament twice while its stalled promise is live', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 100,
      startTimers: false,
    });
    let releaseStalled!: () => void;
    let runs = 0;
    scheduler.register({
      tournamentId: 'stuck',
      run: async () => {
        runs++;
        await new Promise<void>((resolve) => (releaseStalled = resolve));
      },
    });
    await flush();
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    // Its own wake cannot use the compensating slot; a peer can.
    expect(scheduler.wake('stuck')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const peerRuns: string[] = [];
    scheduler.register({ tournamentId: 'peer', run: async () => void peerRuns.push('peer') });
    await flush();
    expect(runs).toBe(1);
    expect(peerRuns).toEqual(['peer']);
    releaseStalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    // The coalesced rerun happens only after the stalled promise settled.
    expect(runs).toBe(2);
    scheduler.stop();
  });

  it('never overlaps replacement generations for the same tournament', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 2,
      sweepWarnMs: 100,
      startTimers: false,
    });
    let releaseOld!: () => void;
    let sameTournamentActive = 0;
    let maxSameTournamentActive = 0;
    const order: string[] = [];

    scheduler.register({
      tournamentId: 'same',
      run: async () => {
        order.push('old');
        sameTournamentActive++;
        maxSameTournamentActive = Math.max(maxSameTournamentActive, sameTournamentActive);
        await new Promise<void>((resolve) => (releaseOld = resolve));
        sameTournamentActive--;
      },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);

    scheduler.register({
      tournamentId: 'same',
      run: async () => {
        order.push('replacement');
        sameTournamentActive++;
        maxSameTournamentActive = Math.max(maxSameTournamentActive, sameTournamentActive);
        sameTournamentActive--;
      },
    });
    scheduler.register({ tournamentId: 'peer', run: async () => void order.push('peer') });
    await flush();
    expect(order).toEqual(['old', 'peer']);

    releaseOld();
    await flush();
    expect(order).toEqual(['old', 'peer', 'replacement']);
    expect(maxSameTournamentActive).toBe(1);
    scheduler.stop();
  });

  it('publishes always-on queue depth, slots, wait age, and registration gauges', () => {
    const names = new Set(alwaysOnRegistry.snapshot().gauges.map((g) => g.name));
    for (const name of [
      'poker_tournament_elimination_scheduler_registered',
      'poker_tournament_elimination_scheduler_queue_depth',
      'poker_tournament_elimination_scheduler_slots_inflight',
      'poker_tournament_elimination_scheduler_stalled_slots',
      'poker_tournament_elimination_scheduler_oldest_wait_ms',
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});
