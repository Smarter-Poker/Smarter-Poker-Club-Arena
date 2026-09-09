import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), alert: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { from: mocks.from }, logBBJCollection: vi.fn() }));
vi.mock('./supabase/bbj.js', () => ({ processBBJPayout: vi.fn(), setBBJPayoutQueue: vi.fn() }));
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
async function exhaustInlineQueueInsert() {
  const promise = queueUnbankedFee('rake', fee);
  await vi.runAllTimersAsync();
  await promise;
}
it('checks and reports a fee after the bounded insert remains unreachable', async () => {
  await exhaustInlineQueueInsert();
  expect(mocks.alert).toHaveBeenCalledWith(
    'critical',
    'FeeReconciler.queue_failed',
    expect.stringContaining('fetch failed'),
    expect.objectContaining({ verifiedUnbanked: true, handId: fee.handId })
  );
});
it('does not raise a money alarm if the exhausted insert belongs to an already banked fee', async () => {
  banked = true;
  await exhaustInlineQueueInsert();
  expect(mocks.from).toHaveBeenCalledWith('rake_records');
  expect(mocks.alert).not.toHaveBeenCalled();
});
it('accepts an acknowledged inline retry without handing the fee to a timer', async () => {
  let inserts = 0;
  mocks.from.mockImplementation((name: string) =>
    name === 'pending_fee_distributions'
      ? {
          ...read(null),
          insert: async () => {
            inserts += 1;
            return { error: inserts < 3 ? { message: 'fetch failed' } : null };
          },
        }
      : read(null)
  );
  await exhaustInlineQueueInsert();
  expect(inserts).toBe(3);
  expect(mocks.alert).not.toHaveBeenCalled();
});
