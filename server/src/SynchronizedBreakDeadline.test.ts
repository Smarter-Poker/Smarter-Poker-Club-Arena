import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let GameServer: (typeof import('./GameServer.js'))['GameServer'];
let TournamentManagerBase: (typeof import('./tournament/TournamentManagerBase.js'))['TournamentManagerBase'];
let ServerTableEngineBase: (typeof import('./engine/ServerTableEngineBase.js'))['ServerTableEngineBase'];
let supabase: (typeof import('./services/supabase.js'))['supabase'];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ GameServer } = await import('./GameServer.js'));
  ({ TournamentManagerBase } = await import('./tournament/TournamentManagerBase.js'));
  ({ supabase } = await import('./services/supabase.js'));
  ({ ServerTableEngineBase } = await import('./engine/ServerTableEngineBase.js'));
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T12:55:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function manager(id: string) {
  return Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: id,
    currentLevel: 0,
    onBreak: true,
    breakCountdownStarted: false,
    captureLifecycleToken: () => 1,
    lifecycleIsCurrent: () => true,
    isRunning: () => true,
    takesSynchronizedBreaks: () => true,
    pauseForBreak: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(true),
    resumeFromBreak: vi.fn().mockResolvedValue(undefined),
  });
}

function server(managers: ReturnType<typeof manager>[]) {
  return Object.assign(Object.create(GameServer.prototype), {
    lifecycleGeneration: 1,
    running: true,
    breakCountdownStarted: true,
    synchronizedBreakGeneration: 0,
    directAdmissionIsCurrent: () => true,
    tournamentEngines: new Map(managers.map((entry) => [entry.tournamentId, entry])),
    breakEndsAt: 0,
    breakResumeTimer: null,
    waitForAllTablesParked: vi.fn().mockResolvedValue(true),
    launchServerLifecycleJob: vi.fn(),
  });
}

function persistence(delayMs = 0) {
  const writes: { id: string; deadline: string }[] = [];
  vi.spyOn(supabase, 'from').mockReturnValue({
    update: (patch: { break_ends_at: string }) => ({
      eq: async (_column: string, id: string) => {
        writes.push({ id, deadline: patch.break_ends_at });
        vi.setSystemTime(Date.now() + delayMs);
        return { error: null };
      },
    }),
  } as never);
  return writes;
}

describe('Synchronized Break Deadline', () => {
  it('persists one deadline and releases at it despite sequential persistence latency', async () => {
    const first = manager('first');
    const second = manager('second');
    const owner = server([first, second]);
    const writes = persistence(2_000);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await owner.triggerSynchronizedBreak();
    const expectedEnd = Date.parse('2026-09-10T13:00:00.000Z');
    expect(owner.breakEndsAt).toBe(expectedEnd);
    expect(writes).toEqual([
      { id: 'first', deadline: new Date(expectedEnd).toISOString() },
      { id: 'second', deadline: new Date(expectedEnd).toISOString() },
    ]);
    for (const participant of [first, second]) {
      expect(participant.broadcast).toHaveBeenCalledWith(
        'tournament_break_started',
        expect.objectContaining({ breakEndsAt: new Date(expectedEnd).toISOString() })
      );
    }
    expect(timers.mock.calls.at(-1)?.[1]).toBe(expectedEnd - Date.now());
  });

  it('gives a late entrant the existing deadline even when its pause takes time', async () => {
    const entrant = manager('late');
    const owner = server([entrant]);
    owner.breakEndsAt = Date.parse('2026-09-10T13:00:00.000Z');
    vi.setSystemTime(new Date('2026-09-10T12:58:00.000Z'));
    entrant.pauseForBreak.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 2_000);
    });
    const writes = persistence();
    await owner.holdIfBreakIsRunning(entrant);
    expect(writes).toEqual([{ id: 'late', deadline: '2026-09-10T13:00:00.000Z' }]);
  });

  it('does not publish a countdown while the participating hand is still draining', async () => {
    const participant = manager('draining');
    const owner = server([participant]);
    let finish!: (parked: boolean) => void;
    owner.waitForAllTablesParked.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    const writes = persistence();
    const pending = owner.triggerSynchronizedBreak();
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.waitForAllTablesParked).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    expect(participant.broadcast).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 70_000);
    finish(true);
    await pending;
    expect(writes).toEqual([{ id: 'draining', deadline: '2026-09-10T13:01:10.000Z' }]);
  });
});

describe('Synchronized Break Drain', () => {
  it('holds a newcomer in the drain phase without inventing a countdown', async () => {
    const entrant = manager('during-drain');
    const owner = server([entrant]);
    owner.breakEndsAt = Date.now() + 420_000;
    owner.breakCountdownStarted = false;
    const writes = persistence();
    await owner.holdIfBreakIsRunning(entrant);
    expect(entrant.pauseForBreak).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('treats a failed table inspection as an unproven drain', () => {
    const participant = manager('unknown');
    participant.tableEngines = new Map([
      [
        'table',
        {
          isWaitingForHandForHand: () => {
            throw new Error('inspection unavailable');
          },
        },
      ],
    ]);
    expect(participant.areAllTablesParked()).toBe(false);
  });

  it('waits for the real hand boundary beyond the old last-hand grace', async () => {
    const participant = manager('slow');
    const owner = server([participant]);
    owner.running = true;
    const started = Date.now();
    participant.areAllTablesParked = () => Date.now() >= started + 121_000;
    owner.sleep = async (milliseconds: number) => {
      vi.setSystemTime(Date.now() + milliseconds);
    };
    const parked = await (GameServer.prototype as any).waitForAllTablesParked.call(owner, [
      participant,
    ]);
    expect(parked).toBe(true);
    expect(Date.now() - started).toBe(121_000);
  });

  function table() {
    const state = { state: 'running', transition: vi.fn() };
    const engine = Object.assign(Object.create(ServerTableEngineBase.prototype), {
      tableId: 'long-drain',
      running: true,
      handForHandPaused: false,
      maintenancePaused: false,
      finalTableDealPaused: false,
      terminalCloseoutPaused: false,
      holdBeforeNextHand: false,
      pauseRequiresExplicitResume: false,
      tournamentMovePauseOwners: new Map(),
      claimedTournamentMovePauseOwners: new Set(),
      handForHandResolve: null,
      pausedSinceMs: 0,
      pauseMaxWaitMs: null,
      pauseGateTimer: null,
      tableFSM: state,
      armUnclaimedTournamentMovePauseExpiry: vi.fn(),
      notifyBoundaryPauseWaiters: vi.fn(),
      markProgress: vi.fn(),
    });
    state.transition.mockImplementation((next: string) => {
      state.state = next;
    });
    return engine;
  }

  it('keeps an explicitly owned break parked until its manager releases it', async () => {
    const engine = table();
    engine.pauseAfterHand(420_000, { beforeNextHand: true, untilResumed: true });
    let released = false;
    const waiting = engine.awaitPauseGate().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(421_000);
    expect(released).toBe(false);
    expect(engine.isWaitingForHandForHand()).toBe(true);
    engine.resumeDealing();
    await waiting;
    expect(released).toBe(true);
  });

  it('retains the ordinary hand-for-hand safety timeout', async () => {
    const engine = table();
    engine.pauseAfterHand();
    let released = false;
    const waiting = engine.awaitPauseGate().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await waiting;
    expect(released).toBe(true);
  });
});

// Append to server/src/SynchronizedBreakDeadline.test.ts in the clock lane.
// This is one additional regression case, with ended-owner and replaced-owner branches.
describe('Synchronized Break Pause Completion', () => {
  it('reconciles a late pause only for the break owner that requested it', async () => {
    for (const replaced of [false, true]) {
      vi.setSystemTime(new Date('2026-09-10T12:59:58.000Z'));
      const entrant = manager(replaced ? 'new-owner' : 'ended-owner');
      const owner = server([entrant]);
      owner.synchronizedBreakGeneration = 1;
      owner.breakEndsAt = Date.parse('2026-09-10T13:00:00.000Z');
      let finishPause!: () => void;
      entrant.pauseForBreak.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishPause = resolve;
          })
      );
      persistence();
      const pending = owner.holdIfBreakIsRunning(entrant);
      vi.setSystemTime(new Date('2026-09-10T13:00:01.000Z'));
      owner.breakEndsAt = 0;
      if (replaced) {
        owner.synchronizedBreakGeneration = 2;
        owner.breakEndsAt = Date.parse('2026-09-10T14:00:00.000Z');
      }
      finishPause();
      await pending;
      expect(entrant.resumeFromBreak).toHaveBeenCalledTimes(replaced ? 0 : 1);
      expect(entrant.broadcast).not.toHaveBeenCalled();
    }
  });
});
