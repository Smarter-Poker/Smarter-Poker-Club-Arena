import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  drainPendingWrites,
  enqueuePendingWrite,
  PENDING_WRITE_BUDGET_MS,
  pendingWriteCount,
  resetPendingWrites,
} from './pendingWrites.js';
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  resetPendingWrites();
});
afterEach(() => {
  resetPendingWrites();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('removes a handled refusal without reporting that the write landed', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const onGiveUp = vi.fn();
  enqueuePendingWrite({
    key: 'test:refused',
    describedAs: 'refused write',
    attempt: async () => ({ done: true, refused: true }),
    onGiveUp,
  });
  await drainPendingWrites('test:');
  expect(pendingWriteCount()).toBe(0);
  expect(log.mock.calls.flat().some((v) => String(v).includes('landed'))).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
  expect(onGiveUp).not.toHaveBeenCalled();
});
it('reports a confirmed write as landed', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  enqueuePendingWrite({
    key: 'test:paid',
    describedAs: 'confirmed write',
    attempt: async () => ({ done: true }),
    onGiveUp: vi.fn(),
  });
  await drainPendingWrites('test:');
  expect(pendingWriteCount()).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('landed'));
});

it('waits out the maintenance freeze without spending its budget (final sweep 2026-09-08)', async () => {
  /* During the :55 break every money write is refused at the database
     (zz_freeze_guard), so a queued write that kept retrying burnt its whole
     168 s budget on guaranteed refusals inside a five-minute break and then
     alarmed about chips that were never at risk. Frozen time is credited
     back, and nothing is attempted while frozen. */
  const { setMaintenanceFrozen } = await import('../../maintenance/freezeState.js');
  const attempt = vi.fn(async () => ({ done: false, error: 'refused' }));
  const onGiveUp = vi.fn();
  enqueuePendingWrite({ key: 'test:frozen', describedAs: 'frozen write', attempt, onGiveUp });
  setMaintenanceFrozen(true);
  try {
    // Three budgets of wall time under the freeze: no attempt, no give-up.
    await vi.advanceTimersByTimeAsync(PENDING_WRITE_BUDGET_MS * 3);
    expect(attempt).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(pendingWriteCount()).toBe(1);
  } finally {
    setMaintenanceFrozen(false);
  }
  // Thawed: the next tick tries, and the budget starts from here.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(attempt).toHaveBeenCalled();
  expect(onGiveUp).not.toHaveBeenCalled();
  expect(pendingWriteCount()).toBe(1);
});
