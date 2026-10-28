import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
function liveHand() {
  const players = [1, 2].map((seat) => ({
    seat,
    user_id: `p${seat}`,
    username: `P${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hand = new HandController(
    {
      tableId: 't',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hand.start();
  const engine = new ServerTableEngine('t') as any;
  engine.running = true;
  engine.handController = hand;
  engine.weeklyPayoutStartedController = hand;
  engine.broadcastCurrentState = vi.fn(async () => {});
  engine.broadcastAllInEquity = vi.fn(async () => {});
  return { engine, hand, players };
}

describe('the real live hand is retained across the original weekly financial edge', () => {
  it('retains only the latest reconnect intent and drops a superseded hand intent', async () => {
    vi.useFakeTimers();
    const { engine, hand } = liveHand();
    engine.lifecycleCanMutate = () => true;
    engine.pauseForWeeklyPayout('weekly');
    engine.engageWeeklyPayoutHandPause('weekly');
    const old = vi.fn(),
      current = vi.fn(),
      stale = vi.fn();
    expect(engine.deferWeeklyPayoutInput('reconnect:p1', hand, old)).toBe(true);
    expect(engine.deferWeeklyPayoutInput('reconnect:p1', hand, current)).toBe(true);
    expect(engine.deferWeeklyPayoutInput('reconnect:p2', null, stale)).toBe(true);
    engine.resumeFromWeeklyPayout('weekly');
    await vi.advanceTimersByTimeAsync(0);
    expect(old).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });
  it('retains countdown pulses and publishes the same unspent display clock after release', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const { engine, hand } = liveHand();
    const emitEvent = vi.fn();
    engine.hub = { emitEvent };
    const actor = hand
      .getState()
      .players.find((player) => player.seat === hand.getState().currentPlayerSeat)!;
    engine.startTurnTimer(actor.user_id, actor.seat, 10);
    await vi.advanceTimersByTimeAsync(2000);
    engine.pauseForWeeklyPayout('weekly');
    engine.engageWeeklyPayoutHandPause('weekly');
    await vi.advanceTimersByTimeAsync(240000);
    expect(emitEvent).not.toHaveBeenCalled();
    engine.resumeFromWeeklyPayout('weekly');
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitEvent).toHaveBeenCalledWith(
      't',
      expect.objectContaining({
        type: 'timer_countdown',
        remaining_ms: 5000,
      })
    );
  });
  it('announcement allows the current decision; the financial edge retains cards, pot, turn and residual', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const { engine, hand } = liveHand();
    const expiry = vi.fn();
    engine.playerTurnStartTime = 100000;
    engine.preciseTimer.startTimer('t', 'p1', 10000, expiry);
    engine.pauseForWeeklyPayout('weekly');
    await vi.advanceTimersByTimeAsync(2000);
    expect(engine.preciseTimer.getRemainingMs('t', 'p1')).toBe(8000);
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(false);
    const before = hand.getState();
    engine.engageWeeklyPayoutHandPause('weekly');
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(true);
    expect(engine.handlePlayerAction('p1', 'fold').code).toBe('WEEKLY_ACCOUNTING_PAUSED');
    await vi.advanceTimersByTimeAsync(240000);
    expect(hand.getState()).toEqual(before);
    expect(expiry).not.toHaveBeenCalled();
    engine.resumeFromWeeklyPayout('foreign');
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(true);
    engine.resumeFromWeeklyPayout('weekly');
    expect(engine.playerTurnStartTime).toBe(340000);
    expect(engine.broadcastCurrentState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7999);
    expect(expiry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expiry).toHaveBeenCalledTimes(1);
  });

  it('does not ACK an admitted original write until it settles, then emits the original barrier event', async () => {
    vi.useFakeTimers();
    const { engine } = liveHand();
    let finish!: () => void;
    engine.trackWeeklyPayoutOriginalWork(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    const boundary = vi.fn();
    engine.onWeeklyPayoutBoundary(boundary);
    engine.pauseForWeeklyPayout('weekly');
    engine.engageWeeklyPayoutHandPause('weekly');
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(true);
    expect(boundary).toHaveBeenCalled();
    engine.resumeFromWeeklyPayout('weekly');
  });

  it('retains the original paced all-in continuation and deals only after the unspent reveal beat', async () => {
    vi.useFakeTimers();
    const { engine, hand } = liveHand();
    const completed = vi.fn();
    hand.onEvent((event) => {
      if (event.type === 'HAND_COMPLETE') completed();
    });
    let state = hand.getState();
    expect(hand.performAction(state.currentPlayerSeat, 'all_in')).toBe(true);
    state = hand.getState();
    expect(hand.performAction(state.currentPlayerSeat, 'call')).toBe(true);
    expect(hand.getCommunityCards()).toHaveLength(0);
    engine.allInFirstPauseMs = 1000;
    const original = engine.pacedAllInRunout(hand.getState().players, hand.getState().pot);
    await vi.advanceTimersByTimeAsync(300);
    engine.pauseForWeeklyPayout('weekly');
    engine.engageWeeklyPayoutHandPause('weekly');
    const before = hand.getState();
    await vi.advanceTimersByTimeAsync(240000);
    expect(hand.getState()).toEqual(before);
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(true);
    engine.resumeFromWeeklyPayout('weekly');
    await vi.advanceTimersByTimeAsync(699);
    expect(hand.getCommunityCards()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(hand.getCommunityCards()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10000);
    await original;
    expect(hand.getCommunityCards()).toHaveLength(5);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(hand.getState().players.reduce((sum, player) => sum + player.stack, 0)).toBe(200);
  });

  it('weekly completion retains the hand until the overlapping daily owner releases', async () => {
    vi.useFakeTimers();
    const { engine, hand } = liveHand();
    engine.pauseForWeeklyPayout('weekly');
    engine.engageWeeklyPayoutHandPause('weekly');
    engine.maintenancePaused = true;
    const before = hand.getState();
    engine.resumeFromWeeklyPayout('weekly');
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(true);
    expect(hand.getState()).toEqual(before);
    engine.resumeFromMaintenance();
    expect(engine.isParkedForWeeklyPayout('weekly')).toBe(false);
    expect(hand.performAction(before.currentPlayerSeat, 'fold')).toBe(true);
  });
});
