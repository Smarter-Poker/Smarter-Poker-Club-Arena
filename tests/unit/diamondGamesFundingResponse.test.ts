import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import DiamondGamesService from '../../src/services/DiamondGamesService';

const success = { ok: true, replayed: false, promo_chips: '25.50', bank_chips: '74.50' };
const fund = () => DiamondGamesService.fundPromo('club-a', 25, 'same-intent');

describe('a funding intent closes only on an authoritative answer', () => {
  beforeEach(() => rpc.mockReset());

  it.each([
    null,
    undefined,
    [],
    {},
    { ok: 'false' },
    { ok: 1 },
    { ok: false },
    { ok: false, error: '' },
    { ok: false, error: 123 },
    { ...success, replayed: undefined },
    { ...success, replayed: 'false' },
    { ...success, promo_chips: undefined },
    { ...success, promo_chips: null },
    { ...success, promo_chips: '' },
    { ...success, promo_chips: 'NaN' },
    { ...success, bank_chips: Infinity },
    { ...success, bank_chips: true },
    { ...success, bank_chips: -1 },
  ])(
    'rejects an unreadable reply (%j), keeping the console in its unknown-outcome path',
    async (data) => {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(fund()).rejects.toThrow('The Funding Response Could Not Be Verified');
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  );

  it.each([false, true])(
    'accepts a complete success with replayed=%s and normalises amounts',
    async (replayed) => {
      rpc.mockResolvedValueOnce({ data: { ...success, replayed }, error: null });
      await expect(fund()).resolves.toEqual({
        ok: true,
        replayed,
        promo_chips: 25.5,
        bank_chips: 74.5,
      });
      expect(rpc).toHaveBeenCalledWith('fn_diamond_game_fund_promo', {
        p_club_id: 'club-a',
        p_amount: 25,
        p_key: 'same-intent',
      });
    }
  );

  it('accepts a definite refusal without inventing balances', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'The Bank Does Not Hold That Many Chips' },
      error: null,
    });
    await expect(fund()).resolves.toEqual({
      ok: false,
      error: 'The Bank Does Not Hold That Many Chips',
    });
  });

  it('propagates a transport error without retrying or changing the key', async () => {
    const error = new Error('connection lost');
    rpc.mockResolvedValueOnce({ data: null, error });
    await expect(fund()).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
