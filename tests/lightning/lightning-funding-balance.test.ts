import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ room: vi.fn(), anchor: vi.fn(), wallet: vi.fn(), eq: vi.fn() }));
vi.mock('../../src/lightning/lightningSession', () => ({
  getLightningPoolSession: f.room,
  fetchLightningAnchorSeat: f.anchor,
}));
vi.mock('../../src/services/WalletService', () => ({
  WalletService: { readPlayerBalance: f.wallet },
}));
vi.mock('../../src/services/DiamondCustodyService', () => ({ getDiamondCustodyBalance: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q = {
        select: () => q,
        eq: (...args: unknown[]) => {
          f.eq(...args);
          return q;
        },
        maybeSingle: async () => ({
          data: {
            club_id: 'club',
            union_id: null,
            arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
          },
          error: null,
        }),
      };
      return q;
    },
  },
}));
import { readTableFundingBalance } from '../../src/services/TableFundingService';
beforeEach(() => {
  vi.clearAllMocks();
  f.room.mockReturnValue({ poolSessionId: 'pool', clusterId: 'cluster' });
  f.anchor.mockResolvedValue({ anchorTableId: 'anchor' });
  f.wallet.mockResolvedValue({ balance: 25 });
});
it('a pool balance reads its exact own anchor and preserves the real wallet scope', async () => {
  expect(await readTableFundingBalance('player', { tableId: 'pool' })).toEqual({ balance: 25 });
  expect(f.anchor).toHaveBeenCalledWith('cluster', 'pool');
  expect(f.eq).toHaveBeenCalledWith('id', 'anchor');
  expect(f.wallet).toHaveBeenCalledWith('player', { tableId: 'anchor' });
});
it('closed or replaced own session never falls back to a room or another wallet', async () => {
  f.anchor.mockResolvedValue(null);
  expect(await readTableFundingBalance('player', { tableId: 'pool' })).toEqual({ balance: null });
  expect(f.eq).not.toHaveBeenCalled();
  expect(f.wallet).not.toHaveBeenCalled();
});
it('unavailable anchor remains unknown without attempting a wallet read', async () => {
  f.anchor.mockRejectedValue(new Error('unavailable'));
  expect(await readTableFundingBalance('player', { tableId: 'pool' })).toEqual({ balance: null });
  expect(f.wallet).not.toHaveBeenCalled();
});
it('ordinary physical tables retain their own scope without a pool lookup RPC', async () => {
  f.room.mockReturnValue(null);
  expect(await readTableFundingBalance('player', { tableId: 'table' })).toEqual({ balance: 25 });
  expect(f.anchor).not.toHaveBeenCalled();
  expect(f.wallet).toHaveBeenCalledWith('player', { tableId: 'table' });
});
