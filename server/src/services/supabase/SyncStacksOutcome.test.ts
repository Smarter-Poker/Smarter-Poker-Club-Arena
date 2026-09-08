import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const from = vi.fn();
const reportError = vi.fn();
const raiseFinancialAlert = vi.fn().mockResolvedValue({ persisted: true });

vi.mock('./client.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('../financialAlerts.js', () => ({
  raiseFinancialAlert: (...args: unknown[]) => raiseFinancialAlert(...args),
}));

import { syncStacks } from './tables.js';
import { pendingWriteCount, resetPendingWrites } from './pendingWrites.js';

const PLAYERS = [
  { user_id: 'player-a', stack: 0, stack_before: 100 },
  { user_id: 'player-b', stack: 200, stack_before: 100 },
];

beforeEach(() => {
  resetPendingWrites();
  vi.clearAllMocks();
});

afterEach(() => {
  resetPendingWrites();
  vi.useRealTimers();
});

describe('syncStacks reports whether the authoritative stack write landed', () => {
  it('returns true only for an accepted database settlement', async () => {
    rpc.mockResolvedValue({ data: { success: true, replay: false }, error: null });

    await expect(syncStacks('table-a', PLAYERS, 42, { rake: 0, bbj: 0 })).resolves.toBe(true);
  });

  it('returns false for a conservation refusal', async () => {
    rpc.mockResolvedValue({
      data: {
        success: false,
        reason: 'refused',
        error: 'conservation violation: expected 200, got 199',
      },
      error: null,
    });

    await expect(syncStacks('table-a', PLAYERS, 43, { rake: 0, bbj: 0 })).resolves.toBe(false);
  });

  it('returns false after bounded inline retries, then lands the write off-path', async () => {
    vi.useFakeTimers();
    rpc.mockRejectedValue(new Error('transport down'));

    const result = syncStacks('table-a', PLAYERS, 44, { rake: 0, bbj: 0 });
    // Four bounded inline backoffs: 200 + 400 + 800 + 1,600ms. Advancing only
    // that budget proves the dealing-path result without draining the durable
    // retry interval that deliberately continues after syncStacks returns.
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(5);
    expect(pendingWriteCount()).toBe(1);

    rpc.mockResolvedValue({ data: { success: true, replay: false }, error: null });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rpc).toHaveBeenCalledTimes(6);
    expect(pendingWriteCount()).toBe(0);
  });
});
