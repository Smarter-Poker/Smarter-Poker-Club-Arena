import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', () => ({ supabase: { rpc } }));
import { readCashAddonReceipt } from './cashAddonReceipt.js';
const receipt = {
  table_id: 'table',
  user_id: 'user',
  amount: '10.25',
  applied_to_seat: true,
  stack: '20.25',
  pending: '0',
  queued: false,
};
beforeEach(() => rpc.mockReset());
describe('cash add-on original operation readback', () => {
  it('returns only validated original amount and current truth', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });
    await expect(readCashAddonReceipt('table', 'user', 'key')).resolves.toEqual({
      amount: 10.25,
      appliedToSeat: true,
      stack: 20.25,
      pending: 0,
      queued: false,
    });
  });
  it('distinguishes an absent operation from an unreadable one', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error('unavailable') });
    await expect(readCashAddonReceipt('table', 'user', 'key')).resolves.toBeNull();
    await expect(readCashAddonReceipt('table', 'user', 'key')).rejects.toThrow('unavailable');
  });
  it.each([
    { user_id: 'other' },
    { table_id: 'other' },
    { amount: -1 },
    { amount: 'NaN' },
    { stack: null },
    { stack: 'Infinity' },
    { pending: -1 },
    { pending: null },
    { applied_to_seat: 'true' },
  ])('refuses malformed readback %s', async (patch) => {
    rpc.mockResolvedValue({ data: { ...receipt, ...patch }, error: null });
    await expect(readCashAddonReceipt('table', 'user', 'key')).rejects.toThrow('Malformed');
  });
});
