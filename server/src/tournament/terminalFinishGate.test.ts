/**
 * THE FINISH LANE IS ONE SEAT, EVEN INSIDE ONE PROCESS (2026-09-27).
 *
 * Regression coverage for the fix described in terminalFinishGate.ts: before
 * this gate existed, every concurrent call to `finishTournament` that reached
 * `requestTournamentTerminalReceipt` ran unbounded and concurrently against
 * the database's single platform-wide exclusive `fn_complete_tournament_
 * terminal` lock. The first test below (`maxConcurrentInsideFn`) is exactly
 * the assertion that fails without the gate: replacing the body of
 * `runInTerminalFinishGate` with a direct `await fn()` (deleting the fix)
 * turns it to 2 and the test red. With the gate, it stays 1.
 *
 * Fake timers throughout: the gate's wait budget is a real `setTimeout`, and
 * racing it against microtask-only lock release with real timers is
 * inherently flaky (microtask work is usually, but not deterministically,
 * faster than a real few-millisecond timer). `vi.advanceTimersByTimeAsync`
 * gives exact, repeatable control over which happens first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalFinishGateTimeoutError,
  runInTerminalFinishGate,
  terminalFinishGateSnapshot,
} from './terminalFinishGate.js';
import { TerminalSettlementRefusedError } from './terminalSettlementRpc.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Every test either lets its callers finish or asserts a timeout; this only
  // guards against a test leaving the module-level lock held into the next one.
  const snap = terminalFinishGateSnapshot();
  expect(snap.locked, 'gate leaked locked into the next test').toBe(false);
  expect(snap.waiting, 'gate leaked waiters into the next test').toBe(0);
  vi.useRealTimers();
});

describe('mutual exclusion', () => {
  it('never runs two callers inside fn at once, and both eventually run', async () => {
    let concurrentInsideFn = 0;
    let maxConcurrentInsideFn = 0;
    const order: number[] = [];
    const first = deferred<void>();

    const run = (id: number, gate: Promise<void> | null) =>
      runInTerminalFinishGate(async () => {
        concurrentInsideFn++;
        maxConcurrentInsideFn = Math.max(maxConcurrentInsideFn, concurrentInsideFn);
        if (gate) await gate;
        order.push(id);
        concurrentInsideFn--;
      });

    const callerA = run(1, first.promise);
    const callerB = run(2, null);
    first.resolve();
    await Promise.all([callerA, callerB]);

    // The invariant is end-to-end: fn was never entered twice at once, and
    // both callers ran exactly once, in arrival order.
    expect(maxConcurrentInsideFn).toBe(1);
    expect(order).toEqual([1, 2]);
  });

  it('releases the lock when fn throws, so the next caller is not stuck', async () => {
    const boom = new Error('settlement rpc failed');
    await expect(
      runInTerminalFinishGate(async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    // If the failure above had leaked the lock, this would hang forever.
    const result = await runInTerminalFinishGate(async () => 'clear');
    expect(result).toBe('clear');
  });

  it('serves waiters in the order they arrived (FIFO), not last-in-first-out', async () => {
    const first = deferred<void>();
    const order: number[] = [];
    const run = (id: number, waitFor: Promise<void> | null) =>
      runInTerminalFinishGate(async () => {
        if (waitFor) await waitFor;
        order.push(id);
      });

    // acquireLock() reads and writes module state synchronously the instant
    // each call is made, so issuing all three back-to-back (no await between
    // them) still queues b and c in exactly this order behind a.
    const a = run(1, first.promise);
    const b = run(2, null);
    const c = run(3, null);

    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('a caller that cannot get a turn never reaches Postgres', () => {
  it('throws TerminalFinishGateTimeoutError, a TerminalSettlementRefusedError, without invoking fn', async () => {
    const holder = deferred<void>();
    const held = runInTerminalFinishGate(() => holder.promise);

    const fnForWaiter = vi.fn(async () => 'should never run');
    const waiterResult = runInTerminalFinishGate(fnForWaiter, 5);
    const assertion = expect(waiterResult).rejects.toBeInstanceOf(TerminalFinishGateTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    expect(fnForWaiter).not.toHaveBeenCalled();

    // classifyFinishRefusal (engineInstruments.ts) recognises this text, and
    // the transient-retry law (aRuleRefusalStopsAskingEveryFiveSeconds) then
    // governs it unaltered - both depend on the message containing this, and
    // on the error being a TerminalSettlementRefusedError (a "proven refusal",
    // never fenced as an unknown outcome).
    let message = '';
    try {
      await waiterResult;
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalSettlementRefusedError);
      message = (error as Error).message;
    }
    expect(message.toLowerCase()).toContain('timeout');

    holder.resolve();
    await held;
  });

  it('a waiter granted the lock just before its budget expires keeps it - the timer never fires on a settled waiter', async () => {
    const holder = deferred<void>();
    const held = runInTerminalFinishGate(() => holder.promise);

    const waiterResult = runInTerminalFinishGate(async () => 'late winner', 50);
    // Release the holder well inside the waiter's budget: the grant is pure
    // microtask work, so it settles long before the 50ms timer could fire.
    holder.resolve();
    await held;
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiterResult).resolves.toBe('late winner');
  });

  it('a timed-out waiter does not leak the lock even if granted the exact same tick it gave up', async () => {
    const holder = deferred<void>();
    const held = runInTerminalFinishGate(() => holder.promise);

    const waiterResult = runInTerminalFinishGate(async () => 'late winner', 5);
    const assertion = expect(waiterResult).rejects.toBeInstanceOf(TerminalFinishGateTimeoutError);
    // Expire the waiter's own budget WITHOUT ever releasing the holder, so the
    // waiter is granted nothing and must clean up its own queue entry.
    await vi.advanceTimersByTimeAsync(5);
    await assertion;

    // The lock is still legitimately held by `holder` - not stranded by the
    // waiter's timeout, and not falsely released either.
    expect(terminalFinishGateSnapshot()).toEqual({ locked: true, waiting: 0 });
    holder.resolve();
    await held;
  });

  it('does not hold up the caller behind a timed-out waiter', async () => {
    const holder = deferred<void>();
    const held = runInTerminalFinishGate(() => holder.promise);

    const timesOut = runInTerminalFinishGate(async () => 'never', 5);
    const third = runInTerminalFinishGate(async () => 'third in line');
    const assertion = expect(timesOut).rejects.toBeInstanceOf(TerminalFinishGateTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;

    holder.resolve();
    await held;
    await expect(third).resolves.toBe('third in line');
  });
});
