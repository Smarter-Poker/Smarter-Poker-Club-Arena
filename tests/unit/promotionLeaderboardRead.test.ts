import { beforeEach, describe, expect, it, vi } from 'vitest';
const { response, from, limit } = vi.hoisted(() => ({
  response: { value: { data: null as unknown, error: null as unknown } },
  from: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from, rpc: vi.fn() } }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock('../../src/services/WalletService', () => ({ WalletService: { logTransaction: vi.fn() } }));
import { promotionService } from '../../src/services/PromotionService';

describe('Promotion Leaderboard Read Boundary', () => {
  beforeEach(() => {
    response.value = { data: [], error: null };
    limit.mockImplementation(() => Promise.resolve(response.value));
    from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit,
    });
  });
  it('propagates database failures to the retry UI rather than reporting an empty race', async () => {
    const failure = { code: '42501', message: 'Unavailable' };
    response.value = { data: null, error: failure };
    await expect(promotionService.getLeaderboard('promotion-1', 10)).rejects.toBe(failure);
  });
  it('returns an empty board only for a successful empty result', async () => {
    await expect(promotionService.getLeaderboard('promotion-1', 10)).resolves.toEqual([]);
    expect(from).toHaveBeenCalledWith('promotion_leaderboards');
    expect(limit).toHaveBeenCalledWith(10);
  });
  it('preserves exact stored score and prize values for display and downstream use', async () => {
    response.value = {
      data: [{ rank: 1, score: 19255.12, prize: 13.37, profiles: { id: 'p1', username: 'River' } }],
      error: null,
    };
    await expect(promotionService.getLeaderboard('promotion-1')).resolves.toEqual([
      expect.objectContaining({ userId: 'p1', rank: 1, score: 19255.12, prize: 13.37 }),
    ]);
  });
});
