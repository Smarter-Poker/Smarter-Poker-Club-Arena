import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'dadadada-dada-dada-dada-dadadadadada';
const CURRENT_SEAT = 3;

type PendingHorseWork = {
  abortController: AbortController;
  dispose: () => void;
};

function installPendingHorseWork(engine: any): PendingHorseWork {
  const abortController = new AbortController();
  const actionTimer = setTimeout(() => {}, 60_000);
  const secondLookTimer = setTimeout(() => {}, 60_000);
  actionTimer.unref?.();
  secondLookTimer.unref?.();
  engine.horseDecisionAbortController = abortController;
  engine.horseActionTimer = actionTimer;
  engine.horseSecondLookTimer = secondLookTimer;
  return {
    abortController,
    dispose: () => {
      clearTimeout(actionTimer);
      clearTimeout(secondLookTimer);
    },
  };
}

function turnHarness(
  options: {
    currentSeat?: number;
    playerCanAct?: boolean;
    preAction?: { action: 'check' | 'fold' | 'call'; amount?: number };
  } = {}
) {
  const currentSeat = options.currentSeat ?? CURRENT_SEAT;
  const player = {
    seat_number: CURRENT_SEAT,
    user_id: 'human-3',
    username: 'Human Three',
    stack: 1_000,
    is_horse: false,
  };
  const state = {
    currentPlayerSeat: currentSeat,
    currentBet: 0,
    minRaise: 20,
    pot: 40,
    communityCards: [],
    stage: 'preflop',
    players: [
      {
        seat: CURRENT_SEAT,
        user_id: player.user_id,
        bet: 0,
        stack: player.stack,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 4,
        user_id: 'other-4',
        bet: 0,
        stack: 1_000,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ],
  };
  const performAction = vi.fn(() => true);
  const startTurnTimer = vi.fn();
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = { action_time_seconds: 15 };
  engine.seatedPlayers = [player];
  engine.handController = {
    getState: () => state,
    performAction,
  };
  engine.preActionEngine = {
    executePreAction: () =>
      options.preAction
        ? { executed: true, action: options.preAction.action, amount: options.preAction.amount }
        : { executed: false },
  };
  engine.disconnectEngine = {
    onPlayerTurn: () => options.playerCanAct ?? true,
    armedAutoActionDeadlineMs: () => Date.now() + 30_000,
    isInReconnectGrace: () => false,
  };
  engine.startTurnTimer = startTurnTimer;
  engine.scheduleHorseAction = vi.fn();
  return { engine, player, state, performAction, startTurnTimer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('horse decision work follows the authoritative turn boundary', () => {
  it('retires the previous horse job when an accepted human turn begins', async () => {
    const { engine, player, startTurnTimer } = turnHarness();
    const pending = installPendingHorseWork(engine);

    await engine.handleTurnChange(
      { type: 'TURN_CHANGE', seat: CURRENT_SEAT, availableActions: [] },
      [player]
    );

    expect(pending.abortController.signal.aborted).toBe(true);
    expect(engine.horseDecisionAbortController).toBeNull();
    expect(engine.horseActionTimer).toBeNull();
    expect(engine.horseSecondLookTimer).toBeNull();
    expect(startTurnTimer).toHaveBeenCalledWith(player.user_id, CURRENT_SEAT, 15);
    pending.dispose();
  });

  it('retires the previous horse job before awaiting a visible pre-action beat', async () => {
    const { engine, player, performAction } = turnHarness({ preAction: { action: 'check' } });
    const pending = installPendingHorseWork(engine);
    let releaseBeat!: () => void;
    engine.sleep = () =>
      new Promise<void>((resolve) => {
        releaseBeat = resolve;
      });

    const handling = engine.handleTurnChange(
      { type: 'TURN_CHANGE', seat: CURRENT_SEAT, availableActions: [] },
      [player]
    );

    expect(pending.abortController.signal.aborted).toBe(true);
    expect(performAction).not.toHaveBeenCalled();
    releaseBeat();
    await handling;
    expect(performAction).toHaveBeenCalledWith(CURRENT_SEAT, 'check', undefined);
    pending.dispose();
  });

  it('retires the previous horse job on the disconnected-player early-return path', async () => {
    const { engine, player, startTurnTimer } = turnHarness({ playerCanAct: false });
    const pending = installPendingHorseWork(engine);

    await engine.handleTurnChange(
      { type: 'TURN_CHANGE', seat: CURRENT_SEAT, availableActions: [] },
      [player]
    );

    expect(pending.abortController.signal.aborted).toBe(true);
    expect(startTurnTimer).not.toHaveBeenCalled();
    pending.dispose();
  });

  it('does not let a stale TURN_CHANGE cancel work owned by the actual current seat', async () => {
    const { engine, player, startTurnTimer } = turnHarness({ currentSeat: 4 });
    const pending = installPendingHorseWork(engine);

    await engine.handleTurnChange(
      { type: 'TURN_CHANGE', seat: CURRENT_SEAT, availableActions: [] },
      [player]
    );

    expect(pending.abortController.signal.aborted).toBe(false);
    expect(engine.horseDecisionAbortController).toBe(pending.abortController);
    expect(startTurnTimer).not.toHaveBeenCalled();
    engine.cancelHorseDecisionWork();
    pending.dispose();
  });
});

describe('forced actions retire speculative horse work before mutating the hand', () => {
  it('cancels before forceResolveSeat calls performAction', () => {
    const { engine } = turnHarness();
    const pending = installPendingHorseWork(engine);
    let wasAbortedAtMutation = false;
    engine.handController.performAction = vi.fn(() => {
      wasAbortedAtMutation = pending.abortController.signal.aborted;
      return true;
    });

    expect(engine.forceResolveSeat(CURRENT_SEAT, true)).toBe(true);

    expect(wasAbortedAtMutation).toBe(true);
    pending.dispose();
  });

  it('cancels before the watchdog direct force-action path', () => {
    const { engine, state } = turnHarness();
    const pending = installPendingHorseWork(engine);
    let wasAbortedAtMutation = false;
    state.currentBet = 100;
    engine.seatedPlayers = [
      {
        seat_number: CURRENT_SEAT,
        user_id: 'human-3',
        username: 'Human Three',
        stack: 1_000,
      },
    ];
    engine.handController.performAction = vi.fn(() => {
      wasAbortedAtMutation = pending.abortController.signal.aborted;
      return true;
    });
    engine.preciseTimer = { hasTimer: () => true };
    engine.timeBankEngine = { playerActed: () => {} };
    engine.lastProgressAtMs = Date.now() - 46_000;

    engine.runTableWatchdog();

    expect(wasAbortedAtMutation).toBe(true);
    pending.dispose();
  });
});
