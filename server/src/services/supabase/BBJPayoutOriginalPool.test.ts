import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.fn();
const from = vi.fn();
vi.mock('./client.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));
import { processBBJPayout, setBBJPayoutQueue, type BBJPayoutQueue } from './bbj.js';

const params = {
  tableId: 'table-1',
  clubId: 'club-1',
  handNumber: 99,
  loserUserId: 'loser',
  winnerUserId: 'winner',
  loserHandName: 'quads',
  winnerHandName: 'straight flush',
  dealtInPlayerIds: ['loser', 'winner'],
  seatedUserIds: [],
  payoutTotalPercent: 25,
};
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let errors: Record<string, string>;
let settle: ReturnType<typeof vi.fn<BBJPayoutQueue['settle']>>;
beforeEach(() => {
  vi.clearAllMocks();
  rows = {
    clubs: [{ id: 'club-1', union_id: 'current-union' }],
    bbj_pools: [
      { id: 'current-pool', union_id: 'current-union', status: 'active' },
      { id: 'original-pool', club_id: 'club-1', status: 'active' },
    ],
    bbj_contributions: [{ table_id: 'table-1', hand_number: 99, pool_id: 'original-pool' }],
    bbj_payouts: [],
  };
  errors = {};
  settle = vi.fn<BBJPayoutQueue['settle']>();
  setBBJPayoutQueue({ claim: vi.fn(), settle });
  from.mockImplementation((name: string) => {
    const filters: Array<[string, unknown]> = [];
    const result = () => {
      const matches = (rows[name] ?? []).filter((row) => filters.every(([k, v]) => row[k] === v));
      return {
        data: matches[0] ?? null,
        error: errors[name]
          ? { message: errors[name] }
          : matches.length > 1
            ? { message: 'multiple rows' }
            : null,
      };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return query;
      },
      maybeSingle: async () => result(),
    };
    return query;
  });
  rpc.mockResolvedValue({ data: [{ applied: false, already_paid: true }], error: null });
});

describe('BBJ payout follows the durable hand destination', () => {
  it.each(['main', 'mini'] as const)('uses the private contribution pool for %s', async (kind) => {
    await processBBJPayout({ ...params, kind, tierId: 'tier-1' });
    expect(rpc).toHaveBeenCalledWith(
      kind === 'mini' ? 'fn_bbj_mini_payout' : 'bbj_atomic_payout_v2',
      expect.objectContaining({ p_pool_id: 'original-pool' })
    );
  });
  it('replays the recorded payout after its pool retires and the club moves', async () => {
    rows.bbj_payouts = [{ table_id: 'table-1', hand_number: 99, pool_id: 'old-pool' }];
    rows.bbj_pools.push({ id: 'old-pool', status: 'retired' });
    await processBBJPayout(params, { fromQueue: true });
    expect(rpc).toHaveBeenCalledWith(
      'bbj_atomic_payout_v2',
      expect.objectContaining({ p_pool_id: 'old-pool' })
    );
  });
  it.each(['bbj_payouts', 'bbj_contributions'])('keeps %s read failures pending', async (name) => {
    errors[name] = 'unreadable receipt';
    expect((await processBBJPayout(params)).status).toBe('queued');
    expect(rpc).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it.each(['bbj_payouts', 'bbj_contributions'])(
    'refuses ambiguous %s destinations',
    async (name) => {
      rows[name] = [
        { table_id: 'table-1', hand_number: 99, pool_id: 'original-pool' },
        { table_id: 'table-1', hand_number: 99, pool_id: 'current-pool' },
      ];
      expect((await processBBJPayout(params)).status).toBe('queued');
      expect(rpc).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    }
  );
  it('waits for an unbanked contribution instead of selecting the current union', async () => {
    rows.bbj_contributions = [];
    expect((await processBBJPayout(params)).status).toBe('queued');
    expect(rpc).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it('does not allocate a new award from a retired destination', async () => {
    rows.bbj_pools[1].status = 'retired';
    expect((await processBBJPayout(params)).status).toBe('queued');
    expect(rpc).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
