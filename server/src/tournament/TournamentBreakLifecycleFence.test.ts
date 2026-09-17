import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../services/supabase.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

const TOURNAMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class BreakHarness extends TournamentManagerBase {
  breakDecision: Promise<boolean> = Promise.resolve(true);
  readonly clockCall = vi.fn();
  readonly broadcastCall = vi.fn<(eventType: string, payload: unknown) => Promise<boolean>>(
    async () => true
  );

  constructor() {
    super(TOURNAMENT_ID, {} as GameServer);
  }

  activate(): void {
    (this as unknown as { lifecycleEpoch: { begin(): unknown } }).lifecycleEpoch.begin();
    this.running = true;
  }

  fence(): void {
    this.fenceForServerShutdown();
  }

  forceBreakState(): void {
    this.onBreak = true;
  }

  breakIsActive(): boolean {
    return this.onBreak;
  }

  addTableEngine(engine: {
    pauseAfterHand?: ReturnType<typeof vi.fn>;
    resumeDealing?: ReturnType<typeof vi.fn>;
  }): void {
    this.tableEngines.set('table-1', engine as never);
  }

  protected override breakApplies(): Promise<boolean> {
    return this.breakDecision;
  }

  protected override broadcast(eventType: string, payload: unknown): Promise<boolean> {
    return this.broadcastCall(eventType, payload);
  }

  protected override startEliminationChecker(): void {}
  protected override startBlindTimer(): void {
    this.clockCall();
  }

  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function stubBreakPersistence(result: Promise<unknown> = Promise.resolve({ error: null })) {
  const eq = vi.fn(() => result);
  const update = vi.fn(() => ({ eq }));
  const from = vi.spyOn(supabase, 'from').mockReturnValue({ update } as never);
  return { from, update, eq };
}

afterEach(() => {
  setMaintenanceFrozen(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('break release requires persistence and current ownership', () => {
  it('holds the break after a returned database error and retries once to release it', async () => {
    vi.useFakeTimers();
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    const persist = stubBreakPersistence();
    persist.eq.mockResolvedValueOnce({ error: { message: 'temporary database failure' } });
    const engine = { resumeDealing: vi.fn() };
    manager.addTableEngine(engine);
    await manager.resumeFromBreak();
    expect(manager.breakIsActive()).toBe(true);
    expect(engine.resumeDealing).not.toHaveBeenCalled();
    expect(manager.clockCall).not.toHaveBeenCalled();
    expect(manager.broadcastCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.breakIsActive()).toBe(false);
    expect(persist.update).toHaveBeenCalledTimes(2);
    expect(engine.resumeDealing).toHaveBeenCalledOnce();
    expect(manager.clockCall).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(persist.update).toHaveBeenCalledTimes(2);
    manager.fence();
  });

  it('coalesces concurrent releases while the durable update is pending', async () => {
    const persistence = deferred<unknown>();
    const persist = stubBreakPersistence(persistence.promise);
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    const first = manager.resumeFromBreak();
    const second = manager.resumeFromBreak();
    expect(manager.breakIsActive()).toBe(true);
    expect(persist.eq).toHaveBeenCalledOnce();
    persistence.resolve({ error: null });
    await Promise.all([first, second]);
    expect(manager.broadcastCall).toHaveBeenCalledOnce();
    expect(manager.clockCall).toHaveBeenCalledOnce();
    manager.fence();
  });

  it('does not release tables when notification returns after ownership is fenced', async () => {
    const broadcast = deferred<boolean>();
    stubBreakPersistence();
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    manager.broadcastCall.mockImplementationOnce(() => broadcast.promise);
    const engine = { resumeDealing: vi.fn() };
    manager.addTableEngine(engine);
    const resuming = manager.resumeFromBreak();
    await vi.waitFor(() => expect(manager.broadcastCall).toHaveBeenCalledOnce());
    manager.fence();
    broadcast.resolve(true);
    await resuming;
    expect(engine.resumeDealing).not.toHaveBeenCalled();
    expect(manager.clockCall).not.toHaveBeenCalled();
  });

  it('cancels a failed-clear retry when ownership ends', async () => {
    vi.useFakeTimers();
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    const persist = stubBreakPersistence(Promise.resolve({ error: { message: 'unavailable' } }));
    await manager.resumeFromBreak();
    manager.fence();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.breakIsActive()).toBe(true);
    expect(persist.update).toHaveBeenCalledOnce();
    expect(manager.clockCall).not.toHaveBeenCalled();
  });
});

describe('tournament break lifecycle fence', () => {
  it('cannot begin a break after eligibility returns to a fenced manager', async () => {
    const eligibility = deferred<boolean>();
    const manager = new BreakHarness();
    manager.activate();
    manager.breakDecision = eligibility.promise;
    const persist = stubBreakPersistence();
    const engine = { pauseAfterHand: vi.fn() };
    manager.addTableEngine(engine);

    const pausing = manager.pauseForBreak(300_000);
    manager.fence();
    eligibility.resolve(true);
    await pausing;

    expect(manager.breakIsActive()).toBe(false);
    expect(persist.from).not.toHaveBeenCalled();
    expect(manager.broadcastCall).not.toHaveBeenCalled();
    expect(engine.pauseAfterHand).not.toHaveBeenCalled();
  });

  it('does not broadcast or pause tables when persistence returns after the fence', async () => {
    const persistence = deferred<unknown>();
    const manager = new BreakHarness();
    manager.activate();
    const persist = stubBreakPersistence(persistence.promise);
    const engine = { pauseAfterHand: vi.fn() };
    manager.addTableEngine(engine);

    const pausing = manager.pauseForBreak(300_000);
    await vi.waitFor(() => expect(persist.eq).toHaveBeenCalledOnce());
    manager.fence();
    persistence.resolve({ error: null });
    await pausing;

    expect(manager.broadcastCall).not.toHaveBeenCalled();
    expect(engine.pauseAfterHand).not.toHaveBeenCalled();
  });

  it('does not pause tables when the break broadcast returns after the fence', async () => {
    const broadcast = deferred<boolean>();
    const manager = new BreakHarness();
    manager.activate();
    stubBreakPersistence();
    const engine = { pauseAfterHand: vi.fn() };
    manager.addTableEngine(engine);
    manager.broadcastCall.mockImplementationOnce(() => broadcast.promise);

    const pausing = manager.pauseForBreak(300_000);
    await vi.waitFor(() => expect(manager.broadcastCall).toHaveBeenCalledOnce());
    manager.fence();
    broadcast.resolve(true);
    await pausing;

    expect(engine.pauseAfterHand).not.toHaveBeenCalled();
  });

  it('does not announce a countdown when its persistence returns after the fence', async () => {
    const persistence = deferred<unknown>();
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    const persist = stubBreakPersistence(persistence.promise);

    const countingDown = manager.beginBreakCountdown(300_000);
    await vi.waitFor(() => expect(persist.eq).toHaveBeenCalledOnce());
    manager.fence();
    persistence.resolve({ error: null });
    await countingDown;

    expect(manager.broadcastCall).not.toHaveBeenCalled();
  });
});

/*
 * 2026-09-10: resumeFromBreak waits out the maintenance thaw before it takes a
 * running tournament off its break (see the comment there). stop() drains the
 * job that is waiting, so the wait must end the moment the manager is fenced,
 * and a fenced manager must leave the break exactly where it was for the
 * engine that adopts the event next.
 */
describe('tournament break resume waits for the maintenance thaw', () => {
  afterEach(() => {
    setMaintenanceFrozen(false);
    vi.useRealTimers();
  });

  it('comes off its break once the maintenance freeze lifts, not before', async () => {
    vi.useFakeTimers();
    setMaintenanceFrozen(true);
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    const persist = stubBreakPersistence();

    const resuming = manager.resumeFromBreak();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(manager.breakIsActive()).toBe(true);
    expect(persist.update).not.toHaveBeenCalled();
    expect(manager.broadcastCall).not.toHaveBeenCalled();

    setMaintenanceFrozen(false);
    await vi.advanceTimersByTimeAsync(TournamentManagerBase.MAINTENANCE_THAW_POLL_MS);
    await resuming;
    expect(manager.breakIsActive()).toBe(false);
    expect(persist.update).toHaveBeenCalledWith({ on_break: false, break_ends_at: null });
    expect(manager.broadcastCall).toHaveBeenCalledWith('break_ended', expect.anything());
  });

  it('stops waiting the moment the manager is fenced, and leaves the break for the next owner', async () => {
    vi.useFakeTimers();
    setMaintenanceFrozen(true);
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    const persist = stubBreakPersistence();

    const resuming = manager.resumeFromBreak();
    await vi.advanceTimersByTimeAsync(1_000);
    // A deploy cutover fences the manager while the thaw is still running.
    manager.fence();
    await vi.advanceTimersByTimeAsync(TournamentManagerBase.MAINTENANCE_THAW_POLL_MS);
    await resuming;

    expect(manager.breakIsActive()).toBe(true);
    expect(persist.from).not.toHaveBeenCalled();
    expect(manager.broadcastCall).not.toHaveBeenCalled();
  });
});

describe('a break release publishes its active clock in the same durable row', () => {
  const now = Date.parse('2026-09-17T13:00:00.000Z');
  function activeClock() {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const manager = new BreakHarness();
    manager.activate();
    manager.forceBreakState();
    const state = manager as any;
    const row: any = {
      id: TOURNAMENT_ID,
      status: 'RUNNING',
      current_level: 2,
      started_at: '2026-09-17T10:00:00.000Z',
      level_started_at: '2026-09-17T12:50:00.000Z',
      on_break: true,
      break_ends_at: '2026-09-17T13:00:00.000Z',
      blind_structure: Array.from({ length: 3 }, () => ({
        smallBlind: 25,
        bigBlind: 50,
        durationMinutes: 10,
      })),
    };
    state.tournamentCache = { ...row };
    state.currentLevel = 2;
    state.savedBlindTimerRemaining = 300000;
    state.startBlindTimer = (TournamentManagerBase.prototype as any).startBlindTimer;
    const writes: Record<string, unknown>[] = [];
    const acknowledge = vi.fn(async () => ({ data: { ...row }, error: null as any }));
    vi.spyOn(supabase, 'from').mockImplementation(() => {
      let patch: Record<string, unknown>;
      const commit = () => {
        writes.push(patch);
        Object.assign(row, patch);
        return acknowledge();
      };
      const query: any = {
        update: (value: Record<string, unknown>) => {
          patch = value;
          return query;
        },
        eq: () => query,
        select: () => query,
        maybeSingle: commit,
        then: (resolve: any, reject: any) => commit().then(resolve, reject),
      };
      return query;
    });
    const engine = { resumeDealing: vi.fn() };
    manager.addTableEngine(engine);
    const wake = vi.spyOn(state, 'scheduleBlindLevelWake');
    return { manager, state, row, writes, acknowledge, engine, wake };
  }

  it('commits the break clear and credited anchor together before releasing any observer or dealer', async () => {
    const f = activeClock();
    const ack = deferred<any>();
    f.acknowledge.mockReturnValueOnce(ack.promise);
    const resuming = f.manager.resumeFromBreak();
    await Promise.resolve();
    expect(f.writes).toEqual([
      { on_break: false, break_ends_at: null, level_started_at: '2026-09-17T12:55:00.000Z' },
    ]);
    expect(f.engine.resumeDealing).not.toHaveBeenCalled();
    expect(f.manager.broadcastCall).not.toHaveBeenCalled();
    expect(f.wake).not.toHaveBeenCalled();
    vi.setSystemTime(now + 2000);
    ack.resolve({ data: { ...f.row }, error: null });
    await resuming;
    expect(f.manager.breakIsActive()).toBe(false);
    expect(f.engine.resumeDealing).toHaveBeenCalledOnce();
    expect(f.state.blindTimerStartedAt).toBe(Date.parse('2026-09-17T12:55:00.000Z'));
    expect(f.wake).toHaveBeenCalledWith(f.row.blind_structure, 298000);
    expect(f.writes).toHaveLength(1); // no detached second anchor write
    f.manager.fence();
  });

  it.each(['missing', 'wrong-anchor', 'wrong-level'])(
    'does not release an unproven %s update result',
    async (kind) => {
      const f = activeClock();
      f.acknowledge.mockImplementationOnce(async () => ({
        data:
          kind === 'missing'
            ? null
            : {
                ...f.row,
                ...(kind === 'wrong-anchor'
                  ? { level_started_at: '2026-09-17T12:50:00.000Z' }
                  : { current_level: 3 }),
              },
        error: null,
      }));
      await f.manager.resumeFromBreak();
      expect(f.manager.breakIsActive()).toBe(true);
      expect(f.engine.resumeDealing).not.toHaveBeenCalled();
      expect(f.wake).not.toHaveBeenCalled();
      f.manager.fence();
    }
  );

  it('keeps the exact anchor across a lost acknowledgement and the existing retry', async () => {
    const f = activeClock();
    f.acknowledge.mockResolvedValueOnce({ data: null, error: null });
    await f.manager.resumeFromBreak();
    expect(f.manager.breakIsActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]).toEqual(f.writes[0]);
    expect(f.row.level_started_at).toBe('2026-09-17T12:55:00.000Z');
    expect(f.wake).toHaveBeenCalledWith(f.row.blind_structure, 299000);
    expect(f.engine.resumeDealing).toHaveBeenCalledOnce();
    f.manager.fence();
  });

  it('does not arm or release from an acknowledged clock after its lifecycle is fenced', async () => {
    const f = activeClock();
    const ack = deferred<any>();
    f.acknowledge.mockReturnValueOnce(ack.promise);
    const resuming = f.manager.resumeFromBreak();
    await Promise.resolve();
    f.manager.fence();
    ack.resolve({ data: { ...f.row }, error: null });
    await resuming;
    expect(f.writes).toHaveLength(1);
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.engine.resumeDealing).not.toHaveBeenCalled();
    expect(f.manager.broadcastCall).not.toHaveBeenCalled();
  });

  it.each(['addon', 'pending', 'terminal', 'stopped', 'future'])(
    'does not manufacture an active clock for %s ownership',
    async (kind) => {
      const f = activeClock();
      if (kind === 'addon') f.state.addOnBreakActive = true;
      if (kind === 'pending')
        f.state.pendingBlindTransition = { previousLevel: 2, nextLevel: 3, level: {} };
      if (kind === 'terminal') f.state.blindClockTerminalCommitted = true;
      if (kind === 'stopped') f.state.running = false;
      if (kind === 'future') f.state.tournamentCache.started_at = '2026-09-17T14:00:00.000Z';
      await f.manager.resumeFromBreak();
      expect(f.writes).toEqual([{ on_break: false, break_ends_at: null }]);
      expect(f.row.level_started_at).toBe('2026-09-17T12:50:00.000Z');
      if (kind === 'pending') expect(f.wake).toHaveBeenCalledWith(f.row.blind_structure, 1000);
      else expect(f.wake).not.toHaveBeenCalled();
      if (kind === 'addon' || kind === 'stopped')
        expect(f.engine.resumeDealing).not.toHaveBeenCalled();
      f.manager.fence();
    }
  );
});
