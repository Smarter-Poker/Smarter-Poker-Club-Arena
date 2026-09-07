import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../services/supabase.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';

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
  readonly broadcastCall = vi.fn<(eventType: string, payload: unknown) => Promise<void>>(
    async () => undefined
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

  addTableEngine(engine: { pauseAfterHand: ReturnType<typeof vi.fn> }): void {
    this.tableEngines.set('table-1', engine as never);
  }

  protected override breakApplies(): Promise<boolean> {
    return this.breakDecision;
  }

  protected override broadcast(eventType: string, payload: unknown): Promise<void> {
    return this.broadcastCall(eventType, payload);
  }

  protected override startEliminationChecker(): void {}

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
  vi.restoreAllMocks();
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
    const broadcast = deferred<void>();
    const manager = new BreakHarness();
    manager.activate();
    stubBreakPersistence();
    const engine = { pauseAfterHand: vi.fn() };
    manager.addTableEngine(engine);
    manager.broadcastCall.mockImplementationOnce(() => broadcast.promise);

    const pausing = manager.pauseForBreak(300_000);
    await vi.waitFor(() => expect(manager.broadcastCall).toHaveBeenCalledOnce());
    manager.fence();
    broadcast.resolve();
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
