import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { rpc, from, reportError } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('./client.js', () => ({ supabase: { rpc, from } }));
vi.mock('../errorReporter.js', () => ({ reportError }));
vi.mock('../financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));
vi.mock('../../observability/engineInstruments.js', () => ({
  bbjSharesParkedTotal: { add: vi.fn() },
}));
import { logBBJCollection } from './bbj.js';

const payment = ['table-1', 'club-1', 1000001, 0.25, 2, 'hand-1'] as const;
const receipt = {
  id: 'contribution-1',
  pool_id: 'pool-1',
  table_id: payment[0],
  club_id: payment[1],
  hand_number: payment[2],
  amount: '0.25',
  big_blind: '2',
  hand_id: payment[5],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());
async function settle(promise = logBBJCollection(...payment)) {
  await vi.runAllTimersAsync();
  return promise;
}

describe('BBJ banking requires an atomic matching receipt', () => {
  it('uses the table-scoped RPC without client pool reads or writes', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });
    expect(await settle()).toBe(true);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('bbj_record_table_contribution', {
      p_table_id: payment[0],
      p_club_id: payment[1],
      p_hand_number: payment[2],
      p_amount: payment[3],
      p_big_blind: payment[4],
      p_hand_id: payment[5],
    });
  });
  it('retries the identical payment after a lost response', async () => {
    rpc
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue({ data: [receipt], error: null });
    expect(await settle()).toBe(true);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    expect(reportError).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...receipt, amount: 0.5 },
    { ...receipt, club_id: 'wrong-club' },
    { ...receipt, hand_id: 'wrong-hand' },
    { ...receipt, table_id: 'wrong-table' },
    { ...receipt, hand_number: 1000002 },
    { ...receipt, big_blind: 3 },
    [receipt, receipt],
  ])('rejects a missing or mismatched receipt: %j', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await settle()).toBe(false);
    expect(reportError).toHaveBeenCalledOnce();
  });
  it('never drops club attribution to retry an old signature', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'schema cache' } });
    expect(await settle()).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const [name, args] of rpc.mock.calls) {
      expect(name).toBe('bbj_record_table_contribution');
      expect(args.p_club_id).toBe(payment[1]);
    }
  });
  it('does not retry a conflicting payment identity', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'identity conflict' } });
    expect(await settle()).toBe(false);
    expect(rpc).toHaveBeenCalledOnce();
  });
  it('accepts a zero drop and refuses nonfinite or negative drops without a payment', async () => {
    expect(await logBBJCollection('t', 'c', 1, 0, 2)).toBe(true);
    for (const amount of [-1, NaN, Infinity]) {
      expect(await logBBJCollection('t', 'c', 1, amount, 2)).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
