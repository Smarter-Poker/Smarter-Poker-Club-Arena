import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
vi.mock('./financialAlerts.js', () => ({ raiseFinancialAlert: alert }));
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
beforeEach(() => {
  rpc.mockReset();
  alert.mockReset();
  alert.mockResolvedValue({ persisted: true, alertId: 'alert' });
});
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
  it('accepts a busted zero release without inventing a wallet journal', async () => {
    const zero = { ...receipt, amount: 0, custody_balance: 0, journal_id: null, debt_settled: 0 };
    rpc.mockResolvedValue({ data: zero, error: null });
    expect(await releaseDiamondEntry('custody', 'request')).toEqual(zero);
    expect(alert).not.toHaveBeenCalled();
  });
  it.each([
    { amount: 0, journal_id: 'fabricated' },
    { amount: 100, journal_id: null },
    { amount: 0, journal_id: null, debt_settled: 1 },
  ])('rejects an incoherent release journal or debt: %j', async (fields) => {
    rpc.mockResolvedValue({ data: { ...receipt, custody_balance: 0, ...fields }, error: null });
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow(
      'Invalid Diamond Custody Receipt'
    );
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

describe('custody failures stay visible without a second money writer', () => {
  it('reports a lost response with its stable identity and does not retry the RPC', async () => {
    rpc.mockRejectedValue(new Error('response lost'));
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow('response lost');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'DiamondCustody.release_unverified',
      'Diamond Custody Did Not Return A Verified Receipt',
      expect.objectContaining({
        custodyId: 'custody',
        requestId: 'request',
        asset: 'diamonds',
        operation: 'release',
        error: 'response lost',
      })
    );
  });
  it('retains the original failure when durable alert delivery fails', async () => {
    alert.mockResolvedValue({ persisted: false, alertId: null });
    rpc.mockResolvedValue({ data: null, error: { message: 'credit refused' } });
    await expect(releaseDiamondEntry('custody', 'request')).rejects.toThrow('credit refused');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });
  it('reports an invalid reservation receipt with the reservation identity', async () => {
    rpc.mockResolvedValue({ data: { ...receipt, amount: 99 }, error: null });
    await expect(reserveDiamondEntry(input)).rejects.toThrow('Diamond Reservation Amount Mismatch');
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'DiamondCustody.reserve_unverified',
      'Diamond Custody Did Not Return A Verified Receipt',
      expect.objectContaining({
        userId: 'user',
        targetId: 'table',
        requestId: 'request',
        asset: 'diamonds',
      })
    );
  });
  it('does not alarm on success or locally rejected invalid input', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });
    await reserveDiamondEntry(input);
    await expect(reserveDiamondEntry({ ...input, amount: 0 })).rejects.toThrow(
      'Invalid Diamond Amount'
    );
    expect(alert).not.toHaveBeenCalled();
  });
});
