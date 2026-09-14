/**
 * DiamondService.getWalletSummary: one RPC, parsed honestly, null on failure.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { DiamondService } = await import('../../src/services/DiamondService');

const payload = {
  user_id: 'u-1',
  on_hand: 1200,
  collateral: '200',
  sendable: 1000,
  in_arena: 350,
  arena_seats: 1,
  arena_entries: 0,
  arena: {
    club_id: '002c2d27-9584-4e52-835a-bb2be148fc81',
    name: 'Diamond Arena',
    slug: 'diamond-arena',
    cash_games_enabled: false,
    tournaments_enabled: false,
  },
  lifetime_earned: 4095,
  lifetime_spent: 12,
  read_at: '2026-09-13T18:00:00Z',
};

describe('DiamondService.getWalletSummary', () => {
  beforeEach(() => rpc.mockReset());

  it('calls fn_diamond_wallet_summary with no arguments (own user only) and maps every figure', async () => {
    rpc.mockResolvedValueOnce({ data: payload, error: null });
    const s = await DiamondService.getWalletSummary();
    expect(rpc).toHaveBeenCalledWith('fn_diamond_wallet_summary');
    expect(s).toEqual({
      onHand: 1200,
      collateral: 200,
      sendable: 1000,
      inArena: 350,
      arenaSeats: 1,
      arenaEntries: 0,
      arena: {
        clubId: '002c2d27-9584-4e52-835a-bb2be148fc81',
        name: 'Diamond Arena',
        slug: 'diamond-arena',
        cashGamesEnabled: false,
        tournamentsEnabled: false,
      },
      lifetimeEarned: 4095,
      lifetimeSpent: 12,
      readAt: '2026-09-13T18:00:00Z',
    });
  });

  it('accepts a one-row array payload', async () => {
    rpc.mockResolvedValueOnce({ data: [payload], error: null });
    expect((await DiamondService.getWalletSummary())?.inArena).toBe(350);
  });

  it('a missing arena block is null, not a fabricated club', async () => {
    rpc.mockResolvedValueOnce({ data: { ...payload, arena: null }, error: null });
    expect((await DiamondService.getWalletSummary())?.arena).toBeNull();
  });

  it('the open flags are booleans read strictly: "true" the string is not open', async () => {
    rpc.mockResolvedValueOnce({
      data: { ...payload, arena: { ...payload.arena, cash_games_enabled: 'true' } },
      error: null,
    });
    expect((await DiamondService.getWalletSummary())?.arena?.cashGamesEnabled).toBe(false);
  });

  it('a failed read is null, never zeros (10.86)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await DiamondService.getWalletSummary()).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ...payload, on_hand: 'x' }, error: null });
    expect(await DiamondService.getWalletSummary()).toBeNull();
    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await DiamondService.getWalletSummary()).toBeNull();
  });
});
