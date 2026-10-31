import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadlineScheduler } from './DeadlineScheduler.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { InsuranceEngine } from './InsuranceEngine.js';
import { HandController } from './HandController.js';
import { completeReconnectFreeze } from '../maintenance/reconnectFreeze.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
import type { Card, HandConfig, SeatPlayer } from '../types.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const scheduler = () => new DeadlineScheduler({ now: () => Date.now() });
const advance = (ms: number) => vi.advanceTimersByTime(ms);

describe('weekly payout retains each original decision clock', () => {
  it('keeps action residual and independently paused insurance clock; wrong/partial owners cannot thaw', () => {
    const s = scheduler();
    const timer = new PreciseActionTimer(undefined, s, () => Date.now());
    const expiry = vi.fn();
    const other = vi.fn();
    timer.startTimer('t', 'p', 10_000, expiry);
    timer.startTimer('t', 'already-paused', 20_000, other);
    timer.pauseTimer('t', 'already-paused');
    advance(3000);
    timer.pauseForWeeklyPayout('t', 'a');
    timer.pauseForWeeklyPayout('t', 'b');
    advance(60_000);
    timer.resumeFromWeeklyPayout('t', 'foreign');
    timer.resumeFromWeeklyPayout('t', 'a');
    expect(timer.getRemainingMs('t', 'p')).toBe(7000);
    expect(expiry).not.toHaveBeenCalled();
    timer.resumeFromWeeklyPayout('t', 'b');
    advance(6900);
    expect(expiry).not.toHaveBeenCalled();
    advance(100);
    expect(expiry).toHaveBeenCalledTimes(1);
    expect(timer.getRemainingMs('t', 'already-paused')).toBe(20_000);
    expect(other).not.toHaveBeenCalled();
    s.stop();
  });

  it('keeps an active time bank allocation, activation stamp and remaining callback', () => {
    const s = scheduler();
    const timer = new PreciseActionTimer(undefined, s, () => Date.now());
    const bank = new TimeBankEngine(timer);
    bank.initializePlayer('t', 'p', { remainingSeconds: 60, usesRemaining: 3 });
    const expiry = vi.fn();
    expect(bank.activate('t', 'p', expiry)).toBe(true);
    advance(5000);
    bank.pauseForWeeklyPayout('t', 'a');
    bank.pauseForWeeklyPayout('t', 'b');
    const before = { ...bank.getPlayerBank('t', 'p')! };
    advance(60_000);
    bank.playerActed('t', 'p');
    expect(bank.getPlayerBank('t', 'p')).toEqual(before);
    bank.resumeFromWeeklyPayout('t', 'a');
    expect(expiry).not.toHaveBeenCalled();
    bank.resumeFromWeeklyPayout('t', 'b');
    expect(bank.getPlayerBank('t', 'p')!.activatedAt).toBe(160_000);
    expect(bank.getUsesRemaining('t', 'p')).toBe(2);
    advance(14_900);
    expect(expiry).not.toHaveBeenCalled();
    advance(100);
    expect(expiry).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('retains disconnect FSM protection and native transport grace rather than exhausting them during the pause', () => {
    const s = scheduler();
    const timer = new PreciseActionTimer(undefined, s, () => Date.now());
    const d = new DisconnectEngine(timer);
    d.registerPlayer('t', 'p');
    d.markDisconnected('t', 'p');
    const before = d.getFsmState('t', 'p')!;
    advance(1000);
    d.pauseForWeeklyPayout('t', 'a');
    advance(300_000);
    expect(d.getFsmState('t', 'p')!.state).toBe(before.state);
    d.resumeFromWeeklyPayout('t', 'foreign');
    expect(d.isParkedForWeeklyPayout('t', 'a')).toBe(true);
    d.resumeFromWeeklyPayout('t', 'a');
    expect(d.getFsmState('t', 'p')!.graceDeadlineMs).toBe(before.graceDeadlineMs! + 300_000);
    d.registerPlayer('t', 'q');
    d.markTransportGone('t', 'q');
    advance(2000);
    d.pauseForWeeklyPayout('t', 'b');
    advance(60_000);
    expect(d.getFsmState('t', 'q')!.state).toBe('CONNECTED');
    d.resumeFromWeeklyPayout('t', 'b');
    advance(6000);
    expect(d.getFsmState('t', 'q')!.state).not.toBe('CONNECTED');
    s.stop();
  });

  it('parks a real RIT offer without changing consent, pot or expiry callback', () => {
    const s = scheduler();
    const rit = new RunItTwiceEngine(undefined, s);
    rit.configure('t', { enabled: true, autoDeclineTimeout: 10, maxRuns: 2 });
    rit.offer('t', 'h', 'a', ['a', 'b'], 100);
    advance(3000);
    rit.pauseForWeeklyPayout('t', 'one');
    rit.pauseForWeeklyPayout('t', 'two');
    advance(60_000);
    expect(rit.accept('t', 'b')).toBe(false);
    expect(rit.getState('t')!.status).toBe('offered');
    expect(rit.getState('t')!.pot).toBe(100);
    rit.resumeFromWeeklyPayout('t', 'one');
    advance(10_000);
    expect(rit.getState('t')!.status).toBe('offered');
    rit.resumeFromWeeklyPayout('t', 'two');
    advance(6900);
    expect(rit.getState('t')!.status).toBe('offered');
    advance(100);
    expect(rit.getState('t')!.status).toBe('declined');
    s.stop();
  });

  it('parks real insurance offer eligibility and the unspent expiry window', () => {
    const s = scheduler();
    const insurance = new InsuranceEngine(undefined, s);
    insurance.configure('t', { enabled: true, offerTimeoutSeconds: 25 });
    const c = (rank: string, suit: string) => ({ rank, suit }) as Card;
    const offers = insurance.createOffers(
      't',
      'h',
      'a',
      [
        { playerId: 'a', holeCards: [c('A', 'hearts'), c('A', 'diamonds')], atRisk: 100 },
        { playerId: 'b', holeCards: [c('K', 'clubs'), c('Q', 'clubs')], atRisk: 100 },
      ],
      [c('A', 'spades'), c('7', 'clubs'), c('2', 'clubs'), c('9', 'hearts')],
      300,
      'nlh',
      false,
      { equity: 84, strictLossPct: 16, pushPct: 0 }
    );
    expect(offers).toHaveLength(1);
    advance(5000);
    insurance.pauseForWeeklyPayout('t', 'one');
    advance(60_000);
    expect(insurance.accept('t', 'a')).toBe(false);
    expect(offers[0].status).toBe('offered');
    insurance.resumeFromWeeklyPayout('t', 'one');
    advance(19_900);
    expect(offers[0].status).toBe('offered');
    advance(100);
    expect(offers[0].status).toBe('declined');
    s.stop();
  });

  it('retains the actual controller cards, pot and turn', () => {
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
    const hc = new HandController(
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
    hc.start();
    const before = hc.getState();
    hc.pauseForWeeklyPayout('one');
    expect(hc.performAction(before.currentPlayerSeat, 'fold')).toBe(false);
    advance(60_000);
    expect(hc.getState()).toEqual(before);
    hc.resumeFromWeeklyPayout('foreign');
    expect(hc.isParkedForWeeklyPayout('one')).toBe(true);
    hc.resumeFromWeeklyPayout('one');
    expect(hc.performAction(before.currentPlayerSeat, 'fold')).toBe(true);
  });
  it('parks the original pineapple settlement callback for its residual beat only', () => {
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
    const hc = new HandController(
      {
        tableId: 't',
        handNumber: 1,
        gameVariant: 'pineapple',
        smallBlind: 1,
        bigBlind: 2,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      } as HandConfig,
      players,
      1
    );
    hc.start();
    for (let guard = 0; hc.getState().stage === 'preflop' && guard < 20; guard++) {
      const state = hc.getState();
      const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
      expect(hc.performAction(actor.seat, state.currentBet > actor.bet ? 'call' : 'check')).toBe(
        true
      );
    }
    expect(hc.getState().stage).toBe('pineapple_discard');
    for (const seat of [1, 2]) expect(hc.performDiscard(seat, 0)).toBe(true);
    advance(100);
    hc.pauseForWeeklyPayout('a');
    hc.pauseForWeeklyPayout('b');
    const before = hc.getState();
    advance(60_000);
    expect(hc.getState()).toEqual(before);
    expect(hc.flushPineappleSettle()).toBe(false);
    hc.resumeFromWeeklyPayout('a');
    advance(1000);
    expect(hc.getState().stage).toBe('pineapple_discard');
    hc.resumeFromWeeklyPayout('b');
    advance(HAND_COMPLETION.DISCARD_SETTLE_MS - 101);
    expect(hc.getState().stage).toBe('pineapple_discard');
    advance(1);
    expect(hc.getState().stage).toBe('flop');
  });

  it('keeps table/event custody isolated and preserves replacement callbacks born while held', () => {
    const s = scheduler();
    const first = vi.fn();
    const replacement = vi.fn();
    const other = vi.fn();
    s.schedule({
      tableId: 't',
      eventId: 'offer:p',
      deadlineMs: Date.now() + 1000,
      callback: first,
    });
    s.pauseForWeeklyPayout('t', 'owner', 'offer:');
    s.schedule({
      tableId: 'other',
      eventId: 'offer:p',
      deadlineMs: Date.now() + 1000,
      callback: other,
    });
    advance(2000);
    expect(other).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    s.schedule({
      tableId: 't',
      eventId: 'offer:p',
      deadlineMs: Date.now() + 5000,
      callback: replacement,
    });
    advance(20_000);
    expect(s.persistPending('t')[0].deadlineMs - Date.now()).toBe(5000);
    s.resumeFromWeeklyPayout('t', 'foreign', 'offer:');
    advance(10_000);
    expect(replacement).not.toHaveBeenCalled();
    s.resumeFromWeeklyPayout('t', 'owner', 'offer:');
    advance(4900);
    expect(replacement).not.toHaveBeenCalled();
    advance(100);
    expect(replacement).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    s.stop();
  });

  it('credits an overlapping completed maintenance freeze once before the deferred weekly release', () => {
    const s = scheduler();
    const timer = new PreciseActionTimer(undefined, s, () => Date.now());
    const d = new DisconnectEngine(timer);
    d.registerPlayer('overlap', 'p');
    d.markDisconnected('overlap', 'p');
    const original = d.getFsmState('overlap', 'p')!;
    advance(1000);
    d.pauseForWeeklyPayout('overlap', 'week');
    advance(30_000);
    // Base releases support custody only after maintenance has completed and
    // its table resume edge is durable; this is that production ordering.
    completeReconnectFreeze(100_000, 31_000);
    d.resumeFromWeeklyPayout('overlap', 'week');
    expect(d.getFsmState('overlap', 'p')!.graceDeadlineMs).toBe(original.graceDeadlineMs! + 31_000);
    s.stop();
  });
  it('retires paused offer custody on engine disposal so a replacement table can offer normally', () => {
    const s = scheduler();
    const old = new RunItTwiceEngine(undefined, s);
    old.configure('t', { enabled: true, autoDeclineTimeout: 10, maxRuns: 2 });
    old.offer('t', 'old', 'a', ['a', 'b'], 100);
    old.pauseForWeeklyPayout('t', 'old-owner');
    old.disposeAll();
    const replacement = new RunItTwiceEngine(undefined, s);
    replacement.configure('t', { enabled: true, autoDeclineTimeout: 10, maxRuns: 2 });
    replacement.offer('t', 'new', 'a', ['a', 'b'], 100);
    advance(10_000);
    expect(replacement.getState('t')!.status).toBe('declined');
    expect(old.getState('t')).toBe(null);
    s.stop();
  });
});
