import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  row: null as any,
  error: null as any,
  chip: vi.fn(),
  diamond: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: mock.row, error: mock.error }),
      };
      return q;
    },
  },
}));
vi.mock('../../src/services/WalletService', () => ({
  WalletService: { readPlayerBalance: mock.chip },
}));
vi.mock('../../src/services/DiamondCustodyService', () => ({
  getDiamondCustodyBalance: mock.diamond,
}));
import {
  readTableFundingBalance,
  readDiamondDepartureOccupancy,
} from '../../src/services/TableFundingService';
beforeEach(() => {
  vi.clearAllMocks();
  mock.error = null;
  mock.row = {
    club_id: 'arena',
    union_id: null,
    arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
  };
});
describe('Authoritative table funding door', () => {
  it('reads spendable Diamonds without touching the chip wallet', async () => {
    mock.diamond.mockResolvedValue({ available: 100, inPlay: 50 });
    expect(await readTableFundingBalance('user', { tableId: 'table' })).toEqual({ balance: 100 });
    expect(mock.chip).not.toHaveBeenCalled();
  });
  it('never falls back to chips when Diamond custody is unavailable', async () => {
    mock.diamond.mockRejectedValue(new Error('offline'));
    expect(await readTableFundingBalance('user', { tableId: 'table' })).toEqual({ balance: null });
    expect(mock.chip).not.toHaveBeenCalled();
  });
  it('refuses unknown and mismatched arena identity', async () => {
    mock.row.arena.id = 'other';
    expect(await readTableFundingBalance('user', { tableId: 'table' })).toEqual({ balance: null });
    expect(mock.diamond).not.toHaveBeenCalled();
    expect(mock.chip).not.toHaveBeenCalled();
  });
  it('preserves chip funding for authoritative chip tables', async () => {
    mock.row.arena = { id: 'arena', asset: 'chips', is_platform: false, union_id: null };
    mock.chip.mockResolvedValue({ balance: 25, source: 'rpc' });
    expect((await readTableFundingBalance('user', { tableId: 'table' })).balance).toBe(25);
    expect(mock.chip).toHaveBeenCalledWith('user', { tableId: 'table' });
  });
  it('refuses a failed table read instead of using current club cache', async () => {
    mock.error = new Error('offline');
    expect(await readTableFundingBalance('user', { tableId: 'table' })).toEqual({ balance: null });
    expect(mock.chip).not.toHaveBeenCalled();
  });
  it('captures exact departure occupancy, leaving failures unconfirmed', async () => {
    mock.row = { occupancy_id: 'generation' };
    expect(await readDiamondDepartureOccupancy('table', 'user')).toBe('generation');
    mock.error = new Error('offline');
    expect(await readDiamondDepartureOccupancy('table', 'user')).toBeUndefined();
  });
});
