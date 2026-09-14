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
