/**
 * PHASE 1 — the discard clock is the server's, per seat, and it can buy time.
 *
 * WHAT WAS WRONG. The round was ONE flat table-wide `setTimeout` and the engine
 * published nothing about it, so the client counted down from its own copy of
 * `action_time_seconds`, anchored to the first frame it saw the stage in. Three
 * ways that lied, all ending the same way - folded on a clock that still read
 * time on screen:
 *
 *   - the client's 15 was a CLIENT default, so a table configured with a
 *     different action time showed a number the engine never used;
 *   - a reconnect mid-round restarted the count from full over a server
 *     deadline that was already half spent;
 *   - switching to the table from another tab re-anchored it again.
 *
 * And a missed discard FOLDS the hand (Dan 2026-08-21), while every other
 * decision on this table can spend a time bank - so the single action most
 * likely to make a player hesitate was the only one with no way to think.
 *
 * These pin the new surface: an absolute per-seat deadline map, published in
 * the snapshot, retired when the seat discards, extendable for ONE seat, and
 * gone the moment the round is over.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

afterEach(() => vi.restoreAllMocks());

function harness(stage = 'pineapple_discard') {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = { action_time_seconds: 15 } as any;
  /** Seats that still owe a discard - the HandController's authority, stubbed. */
  const owes = new Set<number>([1, 2]);
  engine.handController = {
    getState: () => ({ stage, players: [], currentPlayerSeat: 0, currentBet: 0 }),
    owesPineappleDiscard: (seat: number) => owes.has(seat),
    foldForMissedDiscard: vi.fn(() => true),
  };
  engine.__owes = owes;
  engine.seatedPlayers = [
    { seat_number: 1, user_id: 'u1' },
    { seat_number: 2, user_id: 'u2' },
  ];
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
  for (const u of ['u1', 'u2']) {
    engine.timeBankEngine.initializePlayer(TABLE, u, { remainingSeconds: 40, usesRemaining: 2 });
  }
  engine.broadcastCurrentState = vi.fn();
  return engine;
}

/** Open the round by hand, the way handlePineappleDiscard does. */
function openRound(engine: any, ms = 15_000) {
  const deadline = Date.now() + ms;
  engine.pineappleDiscardBaseDeadlineMs = deadline;
  engine.pineappleDiscardDurationMs = ms;
  engine.pineappleDiscardDeadlines.set(1, deadline);
  engine.pineappleDiscardDeadlines.set(2, deadline);
  return deadline;
}

describe('the discard deadline is published, not guessed', () => {
  it('publishes an absolute deadline per user while the round is open', () => {
    const engine = harness();
    const deadline = openRound(engine);

    const f = engine.pineappleDiscardSnapshotFields();
    expect(f.discard_deadline_ms).toBe(deadline);
    expect(f.discard_duration_ms).toBe(15_000);
    expect(f.discard_deadlines).toEqual({ u1: deadline, u2: deadline });
  });

  it('publishes NOTHING outside the round, so a dead clock cannot linger', () => {
    const engine = harness('flop');
    openRound(engine); // state left over from the round that just closed

    const f = engine.pineappleDiscardSnapshotFields();
    expect(f.discard_deadline_ms).toBeNull();
    expect(f.discard_deadlines).toEqual({});
    expect(f.discard_duration_ms).toBe(0);
  });

  it('a seat with no deadline is simply absent from the map', () => {
    const engine = harness();
    openRound(engine);
    engine.pineappleDiscardDeadlines.delete(2); // u2 has discarded

    const f = engine.pineappleDiscardSnapshotFields() as any;
    expect(Object.keys(f.discard_deadlines)).toEqual(['u1']);
  });

  it('never announces a deadline for a seat that already settled its round', () => {
    // A HORSE discards through performDiscard, and an all-in seat through
    // resolvePendingPineappleDiscards - neither passes through submitDiscard,
    // which was the only place the map used to be pruned. Reconciled against
    // the HandController on every publish.
    const engine = harness();
    openRound(engine);
    engine.__owes.delete(2); // seat 2 discarded, by a path that skips submitDiscard

    const f = engine.pineappleDiscardSnapshotFields() as any;
    expect(Object.keys(f.discard_deadlines)).toEqual(['u1']);
    expect(engine.pineappleDiscardDeadlines.has(2)).toBe(false);
  });
});

describe('a time bank works on a discard', () => {
  it('is REFUSED while ordinary clock remains, and arms instead', () => {
    const engine = harness();
    openRound(engine, 15_000); // a full clock still to run

    const r = engine.extendPineappleDiscard('u1');
    expect(r.success).toBe(true);
    expect(r.armed).toBe(true);
    // Nothing spent: same rule as a turn (Dan 2026-08-23).
    expect(engine.timeBankEngine.getUsesRemaining(TABLE, 'u1')).toBe(2);
    expect(engine.timeBankEngine.isArmed(TABLE, 'u1')).toBe(true);
    engine.preciseTimer.dispose();
  });

  it('extends ONLY that seat once the clock is genuinely exhausted', () => {
    const engine = harness();
    const base = openRound(engine, 0); // clock spent

    const r = engine.extendPineappleDiscard('u1');
    expect(r.success).toBe(true);
    expect(r.armed).toBeUndefined();
    expect(r.deadlineMs).toBeGreaterThan(base);

    // u1 bought time; u2 did not.
    expect(engine.pineappleDiscardDeadlines.get(1)).toBe(r.deadlineMs);
    expect(engine.pineappleDiscardDeadlines.get(2)).toBe(base);
    expect(engine.timeBankEngine.getUsesRemaining(TABLE, 'u1')).toBe(1);
    expect(engine.timeBankEngine.getUsesRemaining(TABLE, 'u2')).toBe(2);
    engine.preciseTimer.dispose();
  });

  it('refuses a seat that has already discarded', () => {
    const engine = harness();
    openRound(engine, 0);
    engine.pineappleDiscardDeadlines.delete(1);

    const r = engine.extendPineappleDiscard('u1');
    expect(r.success).toBe(false);
    expect(r.error).toBe('You Have Already Discarded');
    engine.preciseTimer.dispose();
  });

  it('refuses outside the discard round', () => {
    const engine = harness('turn');
    openRound(engine, 0);

    const r = engine.extendPineappleDiscard('u1');
    expect(r.success).toBe(false);
    expect(r.error).toBe('Not In The Discard Round');
    engine.preciseTimer.dispose();
  });
});

describe('the sweep folds only the seats that are genuinely out of time', () => {
  it('does not even ask about a seat that settled by another path', () => {
    vi.useFakeTimers();
    const engine = harness();
    const now = Date.now();
    engine.pineappleDiscardBaseDeadlineMs = now;
    engine.pineappleDiscardDeadlines.set(1, now);
    engine.pineappleDiscardDeadlines.set(2, now);
    engine.__owes.delete(2); // a horse discarded here
    engine.armPineappleDiscardSweep(engine.handController);

    vi.advanceTimersByTime(50);
    expect(engine.handController.foldForMissedDiscard).toHaveBeenCalledWith(1);
    expect(engine.handController.foldForMissedDiscard).not.toHaveBeenCalledWith(2);
    vi.useRealTimers();
    engine.preciseTimer.dispose();
  });

  it('folds an expired seat and leaves an extended one alone', () => {
    vi.useFakeTimers();
    const engine = harness();
    const now = Date.now();
    engine.pineappleDiscardBaseDeadlineMs = now;
    engine.pineappleDiscardDeadlines.set(1, now); // due now
    engine.pineappleDiscardDeadlines.set(2, now + 20_000); // bought time
    engine.armPineappleDiscardSweep(engine.handController);

    vi.advanceTimersByTime(50);
    expect(engine.handController.foldForMissedDiscard).toHaveBeenCalledWith(1);
    expect(engine.handController.foldForMissedDiscard).not.toHaveBeenCalledWith(2);
    // Seat 2 is still owed its round - the sweep re-armed rather than stopping.
    expect(engine.pineappleDiscardDeadlines.has(2)).toBe(true);

    vi.advanceTimersByTime(20_050);
    expect(engine.handController.foldForMissedDiscard).toHaveBeenCalledWith(2);
    vi.useRealTimers();
    engine.preciseTimer.dispose();
  });
});
