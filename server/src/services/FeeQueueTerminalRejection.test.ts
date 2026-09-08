import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { PendingWrite } from './supabase/pendingWrites.js';
const mocks = vi.hoisted(() => ({ from: vi.fn(), enqueue: vi.fn(), alert: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { from: mocks.from }, logBBJCollection: vi.fn() }));
vi.mock('./supabase/bbj.js', () => ({ processBBJPayout: vi.fn(), setBBJPayoutQueue: vi.fn() }));
vi.mock('./supabase/pendingWrites.js', () => ({ enqueuePendingWrite: mocks.enqueue }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./financialAlerts.js', () => ({ raiseFinancialAlert: mocks.alert }));
import { queueUnbankedFee } from './FeeReconciler.js';
const fee = {
  tableId: 'table-1',
  clubId: 'club-1',
  handId: 'hand-1',
  handNumber: 123,
  rake: 4,
  bbj: 1,
  pot: 100,
  numPlayers: 3,
  contributions: { player: 100 },
  lastError: 'fetch failed',
};
let write: PendingWrite;
let insertError: string | null;
let banked: boolean;
function read(data: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'limit']) query[method] = () => query;
  query.maybeSingle = async () => ({ data, error: null });
  return query;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  insertError = 'fetch failed';
  banked = false;
  mocks.alert.mockResolvedValue({ persisted: true });
  mocks.enqueue.mockImplementation((pending: PendingWrite) => {
    write = pending;
    return true;
  });
  mocks.from.mockImplementation((name: string) =>
    name === 'pending_fee_distributions'
      ? {
          ...read(null),
          insert: async () => ({ error: insertError ? { message: insertError } : null }),
        }
      : read(banked ? { id: 'receipt-1' } : null)
  );
});
afterEach(() => vi.useRealTimers());
async function deferFee() {
  const promise = queueUnbankedFee('rake', fee);
  await vi.runAllTimersAsync();
  await promise;
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
}
it('checks and reports a permanently rejected deferred fee before ending its attempt', async () => {
  await deferFee();
  insertError = 'permission denied';
  expect(await write.attempt()).toEqual({ done: true, refused: true });
  expect(mocks.alert).toHaveBeenCalledWith(
    'critical',
    'FeeReconciler.queue_failed',
    expect.stringContaining('permission denied'),
    expect.objectContaining({ verifiedUnbanked: true, handId: fee.handId })
  );
});
it('does not raise a money alarm if the terminal rejection belongs to an already banked fee', async () => {
  await deferFee();
  insertError = 'permission denied';
  banked = true;
  expect(await write.attempt()).toEqual({ done: true, refused: true });
  expect(mocks.from).toHaveBeenCalledWith('rake_records');
  expect(mocks.alert).not.toHaveBeenCalled();
});
it('keeps transient failures pending and accepts an acknowledged insert without an alarm', async () => {
  await deferFee();
  expect(await write.attempt()).toEqual({ done: false, error: 'fetch failed' });
  expect(mocks.alert).not.toHaveBeenCalled();
  insertError = null;
  expect(await write.attempt()).toEqual({ done: true });
  expect(mocks.alert).not.toHaveBeenCalled();
});
