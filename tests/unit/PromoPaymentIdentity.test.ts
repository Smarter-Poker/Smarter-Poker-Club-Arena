import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, emit } = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc,
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: { id: 'club-1', union_id: 'union-1' }, error: null }),
      };
      return builder;
    },
  },
}));
vi.mock('../../src/stores/useUserStore', () => ({ useUserStore: { getState: () => ({}) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit } }));
vi.mock('../../src/services/FinancialAlertService', () => ({ FinancialAlertService: {} }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));

import { WalletService } from '../../src/services/WalletService';

describe('Promo payment request identity', () => {
  beforeEach(() => {
    rpc.mockReset();
    emit.mockClear();
  });

  it('a lost response after commit retries the same payment and pays once', async () => {
    const committed = new Set<string>();
    let paid = 0;
    rpc.mockImplementation(async (_name, payload) => {
      if (!committed.has(payload.p_op_id)) {
        committed.add(payload.p_op_id);
        paid += payload.p_amount;
        throw new Error('network response lost after commit');
      }
      return { data: { success: true, replayed: true }, error: null };
    });
    await WalletService.disbursePromo('club-1', 'player-1', 10);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(paid).toBe(10);
    expect(committed.size).toBe(1);
    expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
  });

  it('two deliberate payments have different identities', async () => {
    rpc.mockResolvedValue({ data: { success: true }, error: null });
    await WalletService.disbursePromo('club-1', 'player-1', 10);
    await WalletService.disbursePromo('club-1', 'player-1', 10);
    expect(rpc.mock.calls[0][1].p_op_id).not.toBe(rpc.mock.calls[1][1].p_op_id);
  });

  it.each([null, {}, { success: false, error: 'Insufficient Promo' }])(
    'an incomplete or refused receipt does not announce a paid disbursement: %j',
    async (data) => {
      rpc.mockResolvedValue({ data, error: null });
      await expect(WalletService.disbursePromo('club-1', 'player-1', 10)).rejects.toThrow();
      expect(emit).not.toHaveBeenCalled();
    }
  );
});
