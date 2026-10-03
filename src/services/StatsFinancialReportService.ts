import { supabase } from '../lib/supabase';

export interface StatsFinancialScope {
  target_user_id: string;
  club_id: string | null;
  asset: string;
  range_days: number | null;
  range_tz: string;
  visibility: 'owner';
}
export interface StatsFinancialReport {
  contract_version: 2;
  scope: StatsFinancialScope;
  generated_at: string;
  availability: Record<string, unknown>;
  tournament_wallet: Record<string, unknown>;
  rakeback: Record<string, unknown>;
  bankroll: { available: false; series: [] };
  cash_sessions: { available: false; sessions: [] };
}

export const StatsFinancialReportService = {
  async get(
    userId: string,
    clubId: string | null,
    days: number | null,
    timezone: string,
    asset: string
  ): Promise<StatsFinancialReport> {
    const { data, error } = await supabase.rpc('ca_player_stats_financial_report', {
      p_user: userId,
      p_club_id: clubId,
      p_days: days,
      p_tz: timezone,
      p_asset: asset,
    });
    if (error) throw error;
    if (
      data?.contract_version !== 2 ||
      data?.scope?.target_user_id !== userId ||
      data?.scope?.club_id !== clubId ||
      data?.scope?.asset !== asset ||
      data?.scope?.range_days !== days ||
      data?.scope?.range_tz !== timezone ||
      data?.scope?.visibility !== 'owner'
    )
      throw new Error('Financial Report Scope Mismatch');
    return data as StatsFinancialReport;
  },
};
