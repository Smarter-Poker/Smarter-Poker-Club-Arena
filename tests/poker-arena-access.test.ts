import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn(), track: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../src/services/ClubEntryTrustService', () => ({
  ClubEntryTrustService: { track: mocks.track },
}));
import { getArenaContext } from '../src/services/ArenaContextService';
import { ClubJoinService } from '../src/services/ClubJoinService';
const identity = { id: 'diamond-id', asset: 'diamonds', is_platform: true, union_id: null };
const entitlement = { arena: identity, member: true, role: 'player' };
const preview = {
  found: true,
  id: 'diamond-id',
  club_id: 99999,
  name: 'Diamond Arena',
  slug: 'diamond-arena',
};
const pendingKey = 'club-arena:pending-join:v1';
describe('Poker Arena authoritative access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
  });
  it('returns player-only capabilities without reading a materialized membership', async () => {
    mocks.rpc.mockResolvedValue({ data: entitlement, error: null });
    expect(await getArenaContext('diamond-id')).toMatchObject({
      member: true,
      automaticMembership: true,
      role: 'player',
      capabilities: { join: false, hierarchy: false, chipWallet: false, diamondTransfers: true },
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_poker_arena_context', {
      p_club_key: 'diamond-id',
    });
  });
  it('revalidates access on every call rather than trusting a cached entitlement', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: entitlement, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'Authentication Required' } });
    await getArenaContext('diamond-id');
    await expect(getArenaContext('diamond-id')).rejects.toThrow('Authentication Required');
  });
  it.each([
    { ...entitlement, role: 'owner' },
    { ...entitlement, member: false },
    { ...entitlement, arena: { ...identity, union_id: 'union-id' } },
    { ...entitlement, arena: { ...identity, asset: 'unknown' } },
  ])('refuses malformed or elevated Diamond entitlement %#', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(getArenaContext('diamond-id')).rejects.toThrow();
  });
  it('leaves public club previews independent of authenticated entitlement', async () => {
    mocks.rpc.mockResolvedValue({ data: preview, error: null });
    expect(await ClubJoinService.preview('99999')).toEqual(preview);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_preview_club_join', {
      p_identifier: '99999',
    });
  });
  it('resumes a stale Diamond join without a join mutation, referral, or membership event', async () => {
    window.localStorage.setItem(
      pendingKey,
      JSON.stringify({
        identifier: '99999',
        referralCode: 'OLD-AGENT',
        requestId: 'retry-id',
        createdAt: Date.now(),
      })
    );
    mocks.rpc
      .mockResolvedValueOnce({ data: entitlement, error: null })
      .mockResolvedValueOnce({ data: preview, error: null });
    const result = await ClubJoinService.resumePending();
    expect(result).toMatchObject({
      success: true,
      status: 'automatic',
      club: { id: 'diamond-id', name: 'Diamond Arena' },
    });
    expect(mocks.rpc.mock.calls.map((call) => call[0])).toEqual([
      'fn_poker_arena_context',
      'fn_preview_club_join',
    ]);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(pendingKey)).toBeNull();
  });
  it('refuses mismatched navigation data before reporting automatic entry success', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: entitlement, error: null })
      .mockResolvedValueOnce({ data: { ...preview, id: 'other-club' }, error: null });
    await expect(ClubJoinService.join({ identifier: '99999' })).rejects.toThrow(
      'Could Not Resolve Diamond Arena'
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('does not fall through to chip joining when the authoritative access call fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Unavailable' } });
    await expect(ClubJoinService.join({ identifier: '99999' })).rejects.toThrow('Unavailable');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
