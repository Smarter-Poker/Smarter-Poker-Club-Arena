import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('./supabase/client.js', () => ({ supabase: { rpc } }));
import { reserveDiamondEntry, releaseDiamondEntry } from './DiamondCustody.js';

const input = {
  userId: 'user',
  purpose: 'cash_seat' as const,
  targetId: 'table',
  entryKey: 'entry',
  amount: 100,
  requestId: 'request',
};
const receipt = {
  success: true,
  custody_id: 'custody',
  request_id: 'request',
  amount: 100,
  available_balance: 900,
  custody_balance: 100,
  journal_id: 'journal',
};
beforeEach(() => rpc.mockReset());
describe('Diamond custody server contract', () => {
  it('preserves the stable reservation identity and authoritative price', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });
    expect(await reserveDiamondEntry(input)).toEqual(receipt);
    expect(rpc).toHaveBeenCalledWith('fn_poker_diamond_reserve', {
      p_user_id: 'user',
      p_purpose: 'cash_seat',
      p_target_id: 'table',
      p_entry_key: 'entry',
      p_amount: 100,
      p_request_id: 'request',
    });
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648])(
    'refuses invalid amount %s before RPC',
    async (amount) => {
      await expect(reserveDiamondEntry({ ...input, amount })).rejects.toThrow(
        'Invalid Diamond Amount'
      );
      expect(rpc).not.toHaveBeenCalled();
    }
  );
  it('does not accept a receipt for a different request', async () => {
    rpc.mockResolvedValue({ data: { ...receipt, request_id: 'other' }, error: null });
    await expect(reserveDiamondEntry(input)).rejects.toThrow('Invalid Diamond Custody Receipt');
  });
  it('does not accept a different reserved amount', async () => {
    rpc.mockResolvedValue({ data: { ...receipt, amount: 99 }, error: null });
    await expect(reserveDiamondEntry(input)).rejects.toThrow('Diamond Reservation Amount Mismatch');
  });
  it('rejects an obsolete pending response from a stale release contract', async () => {
    const pending = {
      success: false,
      pending: true,
      custody_id: 'custody',
      request_id: 'request',
      error: 'diamond_release_pending',
    };
    rpc.mockResolvedValue({ data: pending, error: null });
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow(
      'Invalid Diamond Custody Receipt'
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('retains the original request across caller retries after response loss', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
      .mockResolvedValueOnce({ data: { ...receipt, custody_balance: 0 }, error: null });
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow('connection lost');
    expect(await releaseDiamondEntry('custody', 'request')).toMatchObject({ success: true });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('rejects release receipts belonging to another custody', async () => {
    rpc.mockResolvedValue({ data: { ...receipt, custody_id: 'other' }, error: null });
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow(
      'Diamond Release Custody Mismatch'
    );
  });
  it('rejects a release receipt that still retains custody', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow(
      'Diamond Release Balance Mismatch'
    );
  });
  it.each([-1, 101, 1.5, NaN])('rejects invalid settled debt %s', async (debt_settled) => {
    rpc.mockResolvedValue({ data: { ...receipt, custody_balance: 0, debt_settled }, error: null });
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow(
      'Invalid Diamond Custody Receipt'
    );
  });
  it('rejects a reservation whose held balance differs from its price', async () => {
    rpc.mockResolvedValue({ data: { ...receipt, custody_balance: 99 }, error: null });
    await expect(reserveDiamondEntry(input)).rejects.toThrow(
      'Diamond Reservation Balance Mismatch'
    );
  });
});
