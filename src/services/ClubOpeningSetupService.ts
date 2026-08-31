import { supabase } from '../lib/supabase';

export type OpeningPromotionType =
  | 'leaderboard'
  | 'rake_race'
  | 'milestone'
  | 'mystery'
  | 'high_hand';

export interface ClubOpeningSetupInput {
  clubId: string;
  tagline: string;
  rakePercent: number;
  rakeCapBB: number;
  bbjEnabled: boolean;
  bbjSeed: number;
  spinsEnabled: boolean;
  spinSeed: number;
  spinMaxStake: number;
  promoEnabled: boolean;
  promoType: OpeningPromotionType;
  promoName: string;
  promoDescription: string;
  promoBudget: number;
  leaderboardRewardsEnabled: boolean;
  leaderboardMetric: 'profit' | 'hands_played' | 'tournaments_won' | 'roi';
  leaderboardPrizeBudget: number;
}

export interface ClubOpeningSetupResult {
  success: boolean;
  already_completed: boolean;
  club_id: string;
  club_bank_after: number;
  allocated?: number;
  bbj_seeded?: number;
  spin_seeded?: number;
  promo_budget?: number;
  promotion_id?: string | null;
  operation_id: string;
}

export interface ClubOpeningSetupState {
  completed_at: string;
  bbj_enabled: boolean;
  spins_enabled: boolean;
  promo_enabled: boolean;
}

export const clubOpeningSetupService = {
  async getState(clubId: string): Promise<ClubOpeningSetupState | null> {
    const { data, error } = await supabase
      .from('club_opening_setups' as never)
      .select('completed_at, bbj_enabled, spins_enabled, promo_enabled')
      .eq('club_id', clubId)
      .maybeSingle();
    if (error) throw error;
    return data as ClubOpeningSetupState | null;
  },

  async complete(input: ClubOpeningSetupInput): Promise<ClubOpeningSetupResult> {
    const operationId = crypto.randomUUID();
    const { data, error } = await supabase.rpc(
      'fn_complete_club_opening_setup' as never,
      {
        p_club_id: input.clubId,
        p_operation_id: operationId,
        p_tagline: input.tagline,
        p_rake_percent: input.rakePercent,
        p_rake_cap_bb: input.rakeCapBB,
        p_bbj_enabled: input.bbjEnabled,
        p_bbj_seed: input.bbjEnabled ? input.bbjSeed : 0,
        p_spins_enabled: input.spinsEnabled,
        p_spin_seed: input.spinsEnabled ? input.spinSeed : 0,
        p_spin_max_stake: input.spinsEnabled ? input.spinMaxStake : 0,
        p_promo_enabled: input.promoEnabled,
        p_promo_type: input.promoType,
        p_promo_name: input.promoName,
        p_promo_description: input.promoDescription,
        p_promo_budget: input.promoEnabled ? input.promoBudget : 0,
        p_leaderboard_rewards_enabled: input.leaderboardRewardsEnabled,
        p_leaderboard_metric: input.leaderboardMetric,
        p_leaderboard_prize_budget: input.leaderboardRewardsEnabled
          ? input.leaderboardPrizeBudget
          : 0,
      } as never
    );
    if (error) throw error;
    const result = data as unknown as ClubOpeningSetupResult;
    if (!result?.success) throw new Error('Club Opening Setup Was Not Completed');
    return result;
  },
};
