import { supabase } from '../lib/supabase';

export interface SharedStatsClub {
  id: string;
  name: string;
}
export interface SharedClubOverview {
  hands: number;
  cash_hands: number;
  tournament_hands: number;
  hands_won: number;
  vpip: number;
  pfr: number;
  bb_per_100: number;
  last_played_at: string | null;
}

const assertScope = (data: any, targetUserId: string, asset: string, clubId?: string) => {
  if (
    data?.contract_version !== 2 ||
    data?.scope?.visibility !== 'shared_club' ||
    data?.scope?.target_user_id !== targetUserId ||
    data?.scope?.asset !== asset ||
    (clubId !== undefined && data?.scope?.club_id !== clubId)
  ) {
    throw new Error('Shared Stats Scope Mismatch');
  }
};

export const SharedClubStatsService = {
  async listClubs(targetUserId: string, asset: string): Promise<SharedStatsClub[]> {
    const { data, error } = await supabase.rpc('ca_player_stats_shared_clubs', {
      p_target_user: targetUserId,
      p_asset: asset,
    });
    if (error) throw error;
    assertScope(data, targetUserId, asset);
    return Array.isArray(data.clubs)
      ? data.clubs.filter((c: any) => typeof c?.id === 'string' && typeof c?.name === 'string')
      : [];
  },
  async getOverview(
    targetUserId: string,
    clubId: string,
    days: number | null,
    timezone: string,
    asset: string
  ): Promise<any> {
    const { data, error } = await supabase.rpc('ca_player_stats_shared_overview_v1', {
      p_target_user: targetUserId,
      p_club_id: clubId,
      p_days: days,
      p_tz: timezone,
      p_asset: asset,
    });
    if (error) throw error;
    assertScope(data, targetUserId, asset, clubId);
    return data;
  },
};
