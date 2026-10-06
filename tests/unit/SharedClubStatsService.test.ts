import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { SharedClubStatsService } from '../../src/services/SharedClubStatsService';

const generatedAt = '2026-10-05T12:00:00.000Z';

const overviewPayload = (overrides: Record<string, unknown> = {}) => ({
  contract_version: 2,
  generated_at: generatedAt,
  scope: {
    target_user_id: 'target',
    club_id: 'c1',
    asset: 'chips',
    range_days: 30,
    range_tz: 'America/Chicago',
    visibility: 'shared_club',
  },
  overview: {
    hands: 0,
    cash_hands: 0,
    tournament_hands: 0,
    hands_won: 0,
    vpip: 0,
    pfr: 0,
    bb_per_100: 0,
    last_played_at: null,
  },
  tournaments: { entries: 0, cashes: 0, wins: 0 },
  ...overrides,
});

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
      data: overviewPayload(),
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

  it('preserves a verified zero/empty shared readout', async () => {
    rpc.mockResolvedValue({ data: overviewPayload(), error: null });

    await expect(
      SharedClubStatsService.getOverview('target', 'c1', 30, 'America/Chicago', 'chips')
    ).resolves.toMatchObject({
      overview: { hands: 0, vpip: 0, bb_per_100: 0 },
      tournaments: { entries: 0, cashes: 0, wins: 0 },
    });
  });

  it('rejects tournament wins that exceed cashes even when both fit under entries', async () => {
    rpc.mockResolvedValue({
      data: overviewPayload({ tournaments: { entries: 10, cashes: 2, wins: 3 } }),
      error: null,
    });

    await expect(
      SharedClubStatsService.getOverview('target', 'c1', 30, 'America/Chicago', 'chips')
    ).rejects.toThrow('Readout Could Not Be Verified');
  });

  it('rejects a preflop raise rate above the voluntary investment rate', async () => {
    rpc.mockResolvedValue({
      data: overviewPayload({
        overview: {
          hands: 10,
          cash_hands: 10,
          tournament_hands: 0,
          hands_won: 2,
          vpip: 0.2,
          pfr: 0.3,
          bb_per_100: 1,
          last_played_at: generatedAt,
        },
      }),
      error: null,
    });

    await expect(
      SharedClubStatsService.getOverview('target', 'c1', 30, 'America/Chicago', 'chips')
    ).rejects.toThrow('Readout Could Not Be Verified');
  });

  it('rejects a scope-matching malformed success instead of painting zero or NaN', async () => {
    rpc.mockResolvedValue({
      data: overviewPayload({
        overview: {
          hands: 'not-a-count',
          cash_hands: 0,
          tournament_hands: 0,
          hands_won: 0,
          vpip: 'not-a-rate',
          pfr: 0,
          bb_per_100: 0,
          last_played_at: null,
        },
      }),
      error: null,
    });

    await expect(
      SharedClubStatsService.getOverview('target', 'c1', 30, 'America/Chicago', 'chips')
    ).rejects.toThrow('Readout Could Not Be Verified');
  });

  it('rejects malformed club rows instead of filtering them into a false empty list', async () => {
    rpc.mockResolvedValue({
      data: {
        contract_version: 2,
        scope: { target_user_id: 'target', asset: 'chips', visibility: 'shared_club' },
        clubs: [{ id: null, name: 'Unreadable Club' }],
      },
      error: null,
    });

    await expect(SharedClubStatsService.listClubs('target', 'chips')).rejects.toThrow(
      'Club List Could Not Be Verified'
    );
  });
});
