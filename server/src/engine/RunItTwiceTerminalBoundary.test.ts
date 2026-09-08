import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const TABLE = '91919191-9191-4919-8919-919191919191';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bindPendingHandWait(
  engine: Record<string, any>,
  controller: HandController
): { release: ReturnType<typeof vi.fn>; loop: ReturnType<typeof deferred> } {
  const loop = deferred();
  const release = vi.fn(() => loop.resolve());
  engine.dealingLoopPromise = loop.promise;
  engine.activeHandWaitRelease = { controller, release };
  return { release, loop };
}

async function completionOutcome(promise: Promise<void>): Promise<'complete' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'complete' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function player(seat: number): SeatPlayer {
  return {
    seat,
    user_id: `rit-boundary-${seat}`,
    username: `RIT Boundary ${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  } as SeatPlayer;
}

function harness() {
  const players = [player(1), player(2)];
  const events: HandEvent[] = [];
  const controller = new HandController(
    {
      tableId: TABLE,
      handNumber: 91,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  controller.onEvent((event) => events.push(event));
  controller.start();

  let guard = 0;
  while (!events.some((event) => event.type === 'ALL_IN_RUNOUT') && guard++ < 10) {
    const state = controller.getState();
    if (state.currentPlayerSeat < 0) break;
    controller.performAction(state.currentPlayerSeat, 'all_in', 0);
  }
  expect(events.some((event) => event.type === 'ALL_IN_RUNOUT')).toBe(true);

  const engine = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  engine.running = true;
  engine.handCount = 91;
  engine.handController = controller;
  engine.tableInfo = {
    game_variant: 'nlh',
    game_type: 'cash',
    big_blind: 2,
  };
  engine.seatedPlayers = players.map((seatPlayer) => ({
    seat_number: seatPlayer.seat,
    user_id: seatPlayer.user_id,
    username: seatPlayer.username,
    stack: seatPlayer.stack,
    is_horse: false,
  }));
  engine.hub = { emitEvent: vi.fn() };
  engine.runItTwiceEngine.configure(TABLE, {
    enabled: true,
    autoDeclineTimeout: 10,
    maxRuns: 2,
  });

  const active = controller.getState().players.filter((seatPlayer) => !seatPlayer.is_folded);
  const ids = active.map((seatPlayer) => seatPlayer.user_id);
  engine.runItTwiceEngine.offer(TABLE, `${TABLE}:91`, ids[0], ids, controller.getPot());
  engine.runItTwiceEngine.chooserDecides(TABLE, ids[0], 2);
  engine.runItTwiceEngine.accept(TABLE, ids[1]);

  return { engine, controller, active, events };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Run It Twice terminal error boundary', () => {
  it('disarms the payout fence only after a successful finalization', async () => {
    const { engine, active, events } = harness();
    const restart = vi.fn();
    engine.killForRestart = restart;

    await engine.dealAndResolveRIT(active);

    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
    expect(engine.runoutPayoutMutationUnsafe).toBe(false);
    expect(engine.ritResolutionOwner).toBeNull();
    expect(restart).not.toHaveBeenCalled();
  });

  it('falls back once before payout and removes every partial RIT capture', async () => {
    const { engine, controller, active, events } = harness();
    const restart = vi.fn();
    engine.killForRestart = restart;
    const continuation = vi.spyOn(controller, 'continueRunout');

    vi.spyOn(controller, 'computeLivePots').mockImplementationOnce(() => {
      throw new Error('fault before RIT payout');
    });

    await engine.dealAndResolveRIT(active);

    expect(restart).not.toHaveBeenCalled();
    expect(continuation).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
    expect(engine.runoutPayoutMutationUnsafe).toBe(false);
    expect(engine.currentHandRitBoards).toBe(0);
    expect(engine.currentHandRitBaseBoardCount).toBe(0);
    expect(engine.currentHandRitExtraBoards).toEqual([]);
    expect(
      engine.currentHandActions.filter((action: { action: string }) =>
        action.action.startsWith('rit_board_')
      )
    ).toEqual([]);
  });

  it('contains a rollback-snapshot setup fault at a bare fire-and-forget caller', async () => {
    const { engine, controller, active, events } = harness();
    const restart = vi.fn();
    engine.killForRestart = restart;
    const continuation = vi.spyOn(controller, 'continueRunout');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    engine.currentHandPots = [{ amount: 10, eligible: null }];

    try {
      void engine.dealAndResolveRIT(active);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(continuation).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
      expect(engine.runoutPayoutMutationUnsafe).toBe(false);
      expect(engine.ritResolutionOwner).toBeNull();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('terminates after credit and the no-seat watchdog can never distribute again', async () => {
    const { engine, controller, active, events } = harness();
    const restart = vi.fn();
    engine.killForRestart = restart;
    const continuation = vi.spyOn(controller, 'continueRunout');
    const finalize = vi.spyOn(controller, 'finalizeRunout');
    const credit = vi.spyOn(controller, 'creditRunoutWinnings');

    engine.hub.emitEvent = vi.fn((_tableId: string, event: { type?: string }) => {
      if (event.type === 'showdown') throw new Error('fault after RIT payout credit');
    });

    await engine.dealAndResolveRIT(active);

    expect(credit).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(continuation).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(0);
    expect(engine.runoutPayoutMutationUnsafe).toBe(true);
    expect(restart).toHaveBeenCalledWith('rit_resolution_failed_after_payout_mutation');

    // Reproduce the old delayed failure mode directly. Even if teardown has
    // not yet detached the controller, the watchdog must choose recovery and
    // must never enter HandController's ordinary payout path.
    engine.lifecycleCanMutate = () => true;
    engine.lastProgressAtMs = Date.now() - 60_000;
    engine.runTableWatchdog();

    expect(continuation).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledWith('runout_stalled_after_payout_mutation');
  });

  it('keeps the payout fence armed when finalization silently emits no HAND_COMPLETE', async () => {
    const { engine, controller, active, events } = harness();
    const restart = vi.fn();
    engine.killForRestart = restart;
    const continuation = vi.spyOn(controller, 'continueRunout');
    const credit = vi.spyOn(controller, 'creditRunoutWinnings');
    const finalize = vi.spyOn(controller, 'finalizeRunout').mockImplementation(() => undefined);

    await engine.dealAndResolveRIT(active);

    expect(credit).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(0);
    expect(engine.runoutPayoutMutationUnsafe).toBe(true);
    expect(engine.ritResolutionOwner).toBe(controller);
    expect(restart).toHaveBeenCalledWith('rit_resolution_failed_after_payout_mutation');

    engine.lifecycleCanMutate = () => true;
    engine.lastProgressAtMs = Date.now() - 60_000;
    engine.runTableWatchdog();

    expect(continuation).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledWith('runout_stalled_after_payout_mutation');
  });

  it('releases a direct restart kill so stop completes and a replacement can claim ownership', async () => {
    const { engine, controller } = harness();
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.flushSnapshot = vi.fn(async () => undefined);
    const pending = bindPendingHandWait(engine, controller);

    engine.killForRestartPublic('adversarial_direct_kill');

    expect(pending.release).toHaveBeenCalledTimes(1);
    expect(engine.activeHandWaitRelease).toBeNull();
    const stopping = engine.stop();
    expect(await completionOutcome(stopping)).toBe('complete');
    expect(engine.hasReleasedProcessOwnership()).toBe(true);

    const successor = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
    expect(successor.claimProcessOwnership()).toBe(true);
    successor.flushSnapshot = vi.fn(async () => undefined);
    await successor.stop();
  });

  it('releases the same wait when the unsafe no-seat watchdog owns the kill', async () => {
    const { engine, controller } = harness();
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.flushSnapshot = vi.fn(async () => undefined);
    const pending = bindPendingHandWait(engine, controller);
    const continuation = vi.spyOn(controller, 'continueRunout');
    const restart = vi.spyOn(engine, 'killForRestart');
    engine.runoutPayoutMutationUnsafe = true;
    engine.lifecycleCanMutate = () => true;
    engine.lastProgressAtMs = Date.now() - 60_000;

    engine.runTableWatchdog();

    expect(restart).toHaveBeenCalledWith('runout_stalled_after_payout_mutation');
    expect(continuation).not.toHaveBeenCalled();
    expect(pending.release).toHaveBeenCalledTimes(1);
    expect(engine.activeHandWaitRelease).toBeNull();
    expect(await completionOutcome(engine.stop())).toBe('complete');
  });
});
