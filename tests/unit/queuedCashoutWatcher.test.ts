import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const emit = vi.fn();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: (...a: unknown[]) => emit(...a) },
}));

import {
  __resetQueuedCashoutsForTests,
  __setSeatExitReaderForTests,
  awaitQueuedCashouts,
  hasQueuedCashout,
  watchQueuedCashout,
} from '../../src/services/queuedCashoutWatcher';

const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const O = '33333333-3333-4333-8333-333333333333';

describe('a leave queued behind its hand is followed to the wallet', () => {
  let left = false;
  beforeEach(() => {
    vi.useFakeTimers();
    emit.mockClear();
    left = false;
    __setSeatExitReaderForTests(async () => ({ left }));
  });
  afterEach(() => {
    __resetQueuedCashoutsForTests();
    __setSeatExitReaderForTests(null);
    vi.useRealTimers();
  });

  it('refreshes the wallet and seat lists within a second of the seat closing', async () => {
    watchQueuedCashout(T, U, O);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(emit).not.toHaveBeenCalled();
    left = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emit).toHaveBeenCalledWith(
      'BALANCE_UPDATED',
      expect.objectContaining({ source: 'queued_leave_cashout', userId: U })
    );
    expect(emit).toHaveBeenCalledWith('SEAT_CASHED_OUT', { tableId: T, occupancyId: O });
    expect(hasQueuedCashout(U)).toBe(false);
  });

  it('announces once, however many times the same leave is watched', async () => {
    watchQueuedCashout(T, U, O);
    watchQueuedCashout(T, U, O);
    left = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emit.mock.calls.filter((c) => c[0] === 'SEAT_CASHED_OUT')).toHaveLength(1);
  });

  it('a buy-in waits for the finishing hand, then proceeds', async () => {
    watchQueuedCashout(T, U, O);
    let admitted = false;
    void awaitQueuedCashouts().then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(admitted).toBe(false);
    left = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(admitted).toBe(true);
  });

  it('a buy-in never waits longer than the bound', async () => {
    watchQueuedCashout(T, U, O);
    let admitted = false;
    void awaitQueuedCashouts(5_000).then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(admitted).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('a buy-in with no leave behind it does not wait at all', async () => {
    let admitted = false;
    void awaitQueuedCashouts().then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(true);
  });

  it('keeps following a leave the stay clock holds, and stops after 12 minutes', async () => {
    watchQueuedCashout(T, U, O);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(hasQueuedCashout(U)).toBe(true);
    left = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(emit).toHaveBeenCalledWith('SEAT_CASHED_OUT', { tableId: T, occupancyId: O });

    emit.mockClear();
    left = false;
    const O2 = '44444444-4444-4444-8444-444444444444';
    watchQueuedCashout(T, U, O2);
    await vi.advanceTimersByTimeAsync(12 * 60_000 + 5_000);
    expect(hasQueuedCashout(U)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
