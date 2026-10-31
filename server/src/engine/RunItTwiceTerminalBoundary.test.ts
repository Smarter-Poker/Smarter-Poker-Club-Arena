import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandContinuationLane } from './HandContinuationLane.js';
import { HandController } from './HandController.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
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

const ownedFallbackFixtures: Array<Record<string, any>> = [];
afterEach(async () => {
  for (const engine of ownedFallbackFixtures.splice(0)) await engine.stop();
  vi.restoreAllMocks();
});

describe('Run It Twice terminal error boundary', () => {
  it('ordinary stop releases its exact wait but refuses to discard an unfinished cash original', async () => {
    const { engine, controller } = harness();
    expect(engine.claimProcessOwnership()).toBe(true);
    const original = controller.serializeRecoveryState();
    engine.flushSnapshot = vi.fn(async () => {});
    vi.spyOn(controller, 'start').mockImplementation(() => {});
    engine.discardPreparedHandForPause = () => false;
    const loop = engine.runOriginalController(engine.seatedPlayers, controller, 91, Date.now(), {
      started: true,
      cause: null,
    });
    engine.dealingLoopPromise = loop;
    await Promise.resolve();
    expect(engine.activeHandWaitRelease?.controller).toBe(controller);
    const release = vi.spyOn(engine.activeHandWaitRelease, 'release');
    engine.flushSnapshot.mockClear(); // Ignore the existing hand-start anchor.
    const stopping = engine.stop();
    const outcome = stopping.then(
      () => null,
      (error: unknown) => error
    );
    try {
      expect(await completionOutcome(outcome.then(() => {}))).toBe('complete');
      expect(await outcome).toBeInstanceOf(AggregateError);
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith('engine_stopped', true);
      expect(engine.flushSnapshot).not.toHaveBeenCalled();
      expect(engine.handController).toBe(controller);
      expect(controller.serializeRecoveryState() === original).toBe(true);
      expect(engine.hasReleasedProcessOwnership()).toBe(false);
      expect(engine.stop()).toBe(stopping);
      await expect(engine.stop()).rejects.toThrow('retains unproven original hand custody');
    } finally {
      engine.activeHandWaitRelease?.release('test_cleanup', true);
      await outcome;
      (engine.constructor as any).releaseCurrentEngine(TABLE, engine);
    }
  });

  it.each(['prepared', 'completed', 'external_completed'] as const)(
    'permits retirement at a genuinely %s controller boundary',
    async (boundary) => {
      const { engine, controller, active } = harness();
      expect(engine.claimProcessOwnership()).toBe(true);
      const exact =
        boundary === 'prepared'
          ? new HandController(
              JSON.parse(controller.serializeRecoveryState()).config,
              [player(1), player(2)],
              1
            )
          : controller;
      if (boundary === 'completed') exact.continueRunout();
      if (boundary === 'external_completed') await engine.dealAndResolveRIT(active);
      engine.handController = exact;
      const phase = exact.getLifecyclePhase();
      expect(phase.handStarted).toBe(boundary !== 'prepared');
      expect(phase.handCompleted).toBe(boundary !== 'prepared');
      if (boundary === 'external_completed')
        expect(() => exact.serializeRecoveryState()).toThrow('External Runout Original');
      engine.flushSnapshot = vi.fn(async () => {
        expect(engine.handController).toBe(exact);
      });
      await engine.stop();
      expect(engine.flushSnapshot).toHaveBeenCalledWith(true);
      expect(engine.hasReleasedProcessOwnership()).toBe(true);
    }
  );

  it.each(['unknown', 'malformed'] as const)(
    'retains exact controller custody when its lifecycle phase is %s',
    async (phase) => {
      const { engine, controller } = harness();
      expect(engine.claimProcessOwnership()).toBe(true);
      if (phase === 'unknown')
        vi.spyOn(controller, 'getLifecyclePhase').mockImplementation(() => {
          throw new Error('phase unavailable');
        });
      else vi.spyOn(controller, 'getLifecyclePhase').mockReturnValue({ handStarted: true } as any);
      engine.flushSnapshot = vi.fn(async () => {});
      const stopping = engine.stop();
      try {
        await expect(stopping).rejects.toThrow('retains unproven original hand custody');
        expect(engine.handController).toBe(controller);
        expect(engine.flushSnapshot).not.toHaveBeenCalled();
        expect(engine.hasReleasedProcessOwnership()).toBe(false);
        expect(engine.stop()).toBe(stopping);
      } finally {
        await stopping.catch(() => {});
        (engine.constructor as any).releaseCurrentEngine(TABLE, engine);
      }
    }
  );

  it.each(['quarantine', 'physical_write'] as const)(
    'quiesces the exact pending pineapple beat at the stop fence: %s',
    async (mode) => {
      vi.useFakeTimers();
      const { engine } = harness();
      expect(engine.claimProcessOwnership()).toBe(true);
      const controller = new HandController(
        {
          tableId: TABLE,
          handNumber: 91,
          gameVariant: 'pineapple',
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
        } as HandConfig,
        [player(1), player(2), player(3)],
        1
      );
      engine.handController = controller;
      controller.start();
      for (let action = 0; controller.getState().stage === 'preflop' && action < 20; action++) {
        const state = controller.getState();
        const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
        expect(
          controller.performAction(actor.seat, state.currentBet > actor.bet ? 'call' : 'check', 0)
        ).toBe(true);
      }
      expect(controller.getState().stage).toBe('pineapple_discard');
      for (const seatPlayer of controller.getState().players.filter((p) => !p.is_folded))
        expect(controller.performDiscard(seatPlayer.seat, 0)).toBe(true);
      expect(controller.allPineappleDiscardsIn()).toBe(true);
      expect(controller.getState().stage).toBe('pineapple_discard');
      const original = controller.serializeRecoveryState();
      const entered = deferred();
      const held = deferred();
      if (mode === 'physical_write') {
        engine.handContinuation = new HandContinuationLane(
          0,
          () => controller.serializeRecoveryState(),
          () => ({}),
          async () => {
            entered.resolve();
            await held.promise;
          },
          async () => {},
          () => engine.running,
          () => {}
        );
        engine.handContinuation.checkpoint();
        await entered.promise;
      }
      engine.flushSnapshot = vi.fn(async () => {});
      const cancel = vi.spyOn(controller, 'cancelPineappleSettle');
      const stopping = engine.stop();
      const quiescedAtFence = cancel.mock.calls.length;
      const outcome = stopping.then(
        () => null,
        (error: unknown) => error
      );
      try {
        await vi.advanceTimersByTimeAsync(HAND_COMPLETION.DISCARD_SETTLE_MS + 1);
        expect(controller.serializeRecoveryState() === original).toBe(true);
        expect(controller.getState().stage).toBe('pineapple_discard');
        expect(quiescedAtFence).toBe(1);
        expect(engine.handController).toBe(controller);
        expect(engine.flushSnapshot).not.toHaveBeenCalled();
        expect(engine.hasReleasedProcessOwnership()).toBe(false);
        held.resolve();
        expect(await outcome).toBeInstanceOf(AggregateError);
      } finally {
        held.resolve();
        await outcome;
        controller.cancelPineappleSettle();
        (engine.constructor as any).releaseCurrentEngine(TABLE, engine);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  );

  it.each(['scheduled', 'physical'] as const)(
    'refuses retirement while an accepted %s continuation remains unretained',
    async (stage) => {
      const { engine, controller } = harness();
      expect(engine.claimProcessOwnership()).toBe(true);
      const entered = deferred();
      const held = deferred();
      const persist = vi.fn(async () => {
        entered.resolve();
        await held.promise;
      });
      const dispatch = vi.fn(async () => {});
      const lane = new HandContinuationLane(
        0,
        () => controller.serializeRecoveryState(),
        () => ({}),
        persist,
        dispatch,
        () => engine.running,
        () => {}
      );
      engine.handContinuation = lane;
      const permit = { original: 'unchanged' };
      engine.f06CurrentPermit = permit;
      engine.flushSnapshot = vi.fn(async () => {});
      lane.enqueue({ type: 'TURN_CHANGE', seat: 1, availableActions: ['fold', 'call'] });
      if (stage === 'physical') await entered.promise;
      const stopping = engine.stop();
      const outcome = stopping.then(
        () => null,
        (error: unknown) => error
      );
      try {
        await Promise.resolve();
        expect(engine.hasReleasedProcessOwnership()).toBe(false);
        expect(engine.flushSnapshot).not.toHaveBeenCalled();
        if (stage === 'scheduled') expect(persist).not.toHaveBeenCalled();
        held.resolve();
        expect(await outcome).toBeInstanceOf(AggregateError);
        expect(engine.hasReleasedProcessOwnership()).toBe(false);
        expect(engine.handController).toBe(controller);
        expect(engine.handContinuation).toBe(lane);
        expect(engine.f06CurrentPermit).toBe(permit);
        expect(engine.flushSnapshot).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(engine.stop()).toBe(stopping);
        await expect(engine.stop()).rejects.toThrow('retains unproven original hand custody');
        expect(engine.hasReleasedProcessOwnership()).toBe(false);
      } finally {
        held.resolve();
        await outcome;
        // Only destroy this isolated fixture's private registry entry; do not
        // turn a refused stop into a successful retirement in the test.
        (engine.constructor as any).releaseCurrentEngine(TABLE, engine);
      }
    }
  );

  it('retains controller and process custody until the final snapshot completes', async () => {
    const { engine, controller } = harness();
    expect(engine.claimProcessOwnership()).toBe(true);
    controller.continueRunout();
    const entered = deferred();
    const held = deferred();
    engine.flushSnapshot = vi.fn(async () => {
      expect(engine.handController).toBe(controller);
      entered.resolve();
      await held.promise;
    });
    const stopping = engine.stop();
    try {
      await entered.promise;
      expect(engine.hasReleasedProcessOwnership()).toBe(false);
      held.resolve();
      await stopping;
      expect(engine.hasReleasedProcessOwnership()).toBe(true);
    } finally {
      held.resolve();
      await stopping;
    }
  });

  it('drops the actual paced-runout catch fallback while stop retains unfinished cash custody', async () => {
    const { engine, controller, active } = harness();
    expect(engine.claimProcessOwnership()).toBe(true);
    const original = controller.serializeRecoveryState();
    const continuation = vi.spyOn(controller, 'continueRunout');
    engine.flushSnapshot = vi.fn(async () => {});
    const paced = engine.pacedAllInRunout(active, controller.getPot());
    const stopping = engine.stop();
    const outcome = stopping.then(
      () => null,
      (error: unknown) => error
    );
    try {
      expect(await outcome).toBeInstanceOf(AggregateError);
      await paced;
      expect(engine.handController).toBe(controller);
      expect(continuation).not.toHaveBeenCalled();
      expect(controller.serializeRecoveryState() === original).toBe(true);
      expect(engine.flushSnapshot).not.toHaveBeenCalled();
      expect(engine.hasReleasedProcessOwnership()).toBe(false);
    } finally {
      await paced;
      await outcome;
      (engine.constructor as any).releaseCurrentEngine(TABLE, engine);
    }
  });

  it.each(['rit', 'insurance'] as const)(
    'drops a late %s response while stop retains unfinished cash custody',
    async (kind) => {
      vi.useFakeTimers();
      const { engine, controller } = harness();
      expect(engine.claimProcessOwnership()).toBe(true);
      const original = controller.serializeRecoveryState();
      engine.flushSnapshot = vi.fn(async () => {});
      const continuation = vi.spyOn(controller, 'continueRunout');
      // The real wait finish catch owns this synchronous runout fallback.
      const onComplete = vi.fn(() => {
        throw new Error('response consumer failed');
      });
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const clearedIntervals = vi.spyOn(globalThis, 'clearInterval');
      if (kind === 'rit') engine.waitForRITResponse(onComplete);
      else {
        vi.spyOn(engine.insuranceEngine, 'allResponded').mockReturnValue(true);
        engine.waitForInsuranceResponses(onComplete);
      }
      const interval = intervals.mock.results.at(-1)!.value;
      const stopping = engine.stop();
      const outcome = stopping.then(
        () => null,
        (error: unknown) => error
      );
      try {
        expect(await outcome).toBeInstanceOf(AggregateError);
        expect(engine.handController).toBe(controller);
        await vi.advanceTimersByTimeAsync(250);
        expect(onComplete).not.toHaveBeenCalled();
        expect(continuation).not.toHaveBeenCalled();
        expect(controller.serializeRecoveryState() === original).toBe(true);
        expect(clearedIntervals).toHaveBeenCalledWith(interval);
      } finally {
        await outcome;
        (engine.constructor as any).releaseCurrentEngine(TABLE, engine);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  );

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
    expect(engine.claimProcessOwnership()).toBe(true);
    ownedFallbackFixtures.push(engine);
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
    expect(engine.claimProcessOwnership()).toBe(true);
    ownedFallbackFixtures.push(engine);
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
