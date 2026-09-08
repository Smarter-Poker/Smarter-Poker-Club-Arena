import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../errorReporter.js', () => ({ reportError: mocks.report }));
import { autoRebuyHorse } from './wallets.js';
const table = '70000000-0000-4000-8000-000000000002';
const user = '70000000-0000-4000-8000-000000000003';
const club = '70000000-0000-4000-8000-000000000001';
function receipt(payload: any) {
  return {
    data: {
      success: true,
      op_id: payload.p_op_id,
      table_id: table,
      user_id: user,
      club_id: club,
      amount: 5,
      new_stack: 7,
    },
    error: null,
  };
}
describe('horse funding acknowledges a bound receipt, not a transport guess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.rpc.mockReset();
    mocks.report.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  it('uses the database stack, including credits already on the seat', async () => {
    mocks.rpc.mockImplementation(async (_rpc, payload) => receipt(payload));
    expect(await autoRebuyHorse(table, user, 5, club, 91)).toEqual({ status: 'funded', stack: 7 });
  });
  it('retries a lost response with the exact same operation and payload', async () => {
    mocks.rpc
      .mockRejectedValueOnce(new Error('lost response'))
      .mockImplementation(async (_rpc, payload) => receipt(payload));
    const pending = autoRebuyHorse(table, user, 5, club, 91);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'funded', stack: 7 });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0]).toEqual(mocks.rpc.mock.calls[1]);
  });
  it('keeps the same identity across both callers for a hand and changes it for a later hand', async () => {
    mocks.rpc.mockImplementation(async (_rpc, payload) => receipt(payload));
    await autoRebuyHorse(table, user, 5, club, 91);
    await autoRebuyHorse(table, user, 5, club, 91);
    await autoRebuyHorse(table, user, 5, club, 92);
    expect(mocks.rpc.mock.calls[0][1].p_op_id).toBe(mocks.rpc.mock.calls[1][1].p_op_id);
    expect(mocks.rpc.mock.calls[0][1].p_op_id).not.toBe(mocks.rpc.mock.calls[2][1].p_op_id);
  });
  it.each(['insufficient club treasury', 'no active seat for user at table'])(
    'recognizes an explicit refusal: %s',
    async (error) => {
      mocks.rpc.mockResolvedValue({ data: { success: false, error }, error: null });
      expect(await autoRebuyHorse(table, user, 5, club, 91)).toEqual({ status: 'declined' });
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    'transport',
    'missing',
    'wrong-user',
    'wrong-amount',
    'wrong-key',
    'wrong-stack',
    'denied',
  ])('preserves uncertainty for %s', async (kind) => {
    mocks.rpc.mockImplementation(async (_rpc, payload) => {
      if (kind === 'transport') throw new Error('lost response');
      if (kind === 'missing') return { data: null, error: null };
      const result = receipt(payload);
      if (kind === 'wrong-user') result.data.user_id = 'other';
      if (kind === 'wrong-amount') result.data.amount = 6;
      if (kind === 'wrong-key') result.data.op_id = 'other';
      if (kind === 'wrong-stack') result.data.new_stack = NaN;
      if (kind === 'denied')
        return { data: { success: false, error: 'not authorized' }, error: null };
      return result;
    });
    const pending = autoRebuyHorse(table, user, 5, club, 91);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'unknown' });
    expect(
      mocks.rpc.mock.calls.every(
        (call) => JSON.stringify(call) === JSON.stringify(mocks.rpc.mock.calls[0])
      )
    ).toBe(true);
  });
});
