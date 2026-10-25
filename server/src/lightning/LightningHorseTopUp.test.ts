import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ from: vi.fn(), own: vi.fn(), wallet: vi.fn(), request: vi.fn() }));
vi.mock('../services/supabase.js', () => ({
  supabase: { from: f.from },
  readHorseTopUpSeat: f.own,
  readClubChipBalances: f.wallet,
}));
vi.mock('./LightningTopUp.js', () => ({ requestLightningTopUp: f.request }));
import { requestLightningHorseTopUps } from './LightningHorseTopUp.js';
import { horseCashTopUpStyle } from '../services/HorseTopUpStyle.js';
const horse = Array.from({ length: 100 }, (_, i) => `horse-${i}`).find(
  (id) => horseCashTopUpStyle(id, 'plo5') === 'auto_top_up'
)!;
const boundary = { handId: 'hand-a', clusterId: 'cluster', horsePlayers: [{ playerId: horse }] };
beforeEach(() => {
  vi.clearAllMocks();
  const q: any = {
    maybeSingle: async () => ({
      data: {
        table_id: 'anchor',
        stack: 20,
        tables: {
          cluster_id: 'cluster',
          game_variant: 'plo5',
          big_blind: 1,
          min_buy_in: 20,
          max_buy_in: 100,
        },
      },
      error: null,
    }),
  };
  for (const method of ['select', 'eq', 'is', 'limit']) q[method] = () => q;
  f.from.mockReturnValue(q);
  f.own.mockResolvedValue({ autoTopUp: true, clubId: 'club', invested: 20 });
  f.wallet.mockResolvedValue(new Map([[horse, 100000]]));
  f.request.mockResolvedValue({ queued: true, charged: false, applied: 0 });
});
describe('a Lightning horse supplies the same original intent', () => {
  it('uses explicit seat opt-in, actual bankroll policy and stable original hand/user key', async () => {
    await requestLightningHorseTopUps(boundary);
    expect(f.own).toHaveBeenCalledWith('anchor', horse);
    expect(f.request).toHaveBeenCalledOnce();
    const [table, user, key, amount] = f.request.mock.calls[0];
    expect([table, user]).toEqual(['anchor', horse]);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThanOrEqual(80);
    await requestLightningHorseTopUps(boundary);
    expect(f.request.mock.calls[1]).toEqual(f.request.mock.calls[0]);
  });
  it.each([false, undefined])(
    'does not invent an opt-in when the original flag is %s',
    async (flag) => {
      f.own.mockResolvedValue({ autoTopUp: flag, clubId: 'club', invested: 20 });
      await requestLightningHorseTopUps(boundary);
      expect(f.request).not.toHaveBeenCalled();
    }
  );
  it('does not fund with unknown wallet or missing original participant list', async () => {
    f.wallet.mockResolvedValue(new Map());
    await requestLightningHorseTopUps(boundary);
    await requestLightningHorseTopUps({ ...boundary, horsePlayers: undefined });
    expect(f.request).not.toHaveBeenCalled();
  });
});
