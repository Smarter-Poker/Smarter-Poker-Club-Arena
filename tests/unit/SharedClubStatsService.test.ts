import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { SharedClubStatsService } from '../../src/services/SharedClubStatsService';

describe('SharedClubStatsService', () => {
  beforeEach(() => rpc.mockReset());
  it('uses only the shared-club discovery door', async () => {
    rpc.mockResolvedValue({
      data: {
        contract_version: 2,
        scope: { target_user_id: 'target', asset: 'chips', visibility: 'shared_club' },
        clubs: [{ id: 'c1', name: 'Exact Brand' }],
      },
      error: null,
    });
    await expect(SharedClubStatsService.listClubs('target', 'chips')).resolves.toEqual([
      { id: 'c1', name: 'Exact Brand' },
    ]);
    expect(rpc).toHaveBeenCalledWith('ca_player_stats_shared_clubs', {
      p_target_user: 'target',
      p_asset: 'chips',
    });
  });
  it('rejects a mismatched scope instead of displaying or caching it', async () => {
    rpc.mockResolvedValue({
      data: {
        contract_version: 2,
        scope: {
          target_user_id: 'other',
          club_id: 'c1',
          asset: 'chips',
          visibility: 'shared_club',
        },
        overview: {},
      },
      error: null,
    });
    await expect(
      SharedClubStatsService.getOverview('target', 'c1', 30, 'UTC', 'chips')
    ).rejects.toThrow('Scope Mismatch');
  });
  it('passes exact club, range, timezone, and asset without an All Clubs option', async () => {
    rpc.mockResolvedValue({
      data: {
        contract_version: 2,
        scope: {
          target_user_id: 'target',
          club_id: 'c1',
          asset: 'chips',
          visibility: 'shared_club',
        },
        overview: {},
      },
      error: null,
    });
    await SharedClubStatsService.getOverview('target', 'c1', 30, 'America/Chicago', 'chips');
    expect(rpc).toHaveBeenCalledWith('ca_player_stats_shared_overview_v1', {
      p_target_user: 'target',
      p_club_id: 'c1',
      p_days: 30,
      p_tz: 'America/Chicago',
      p_asset: 'chips',
    });
  });
});
