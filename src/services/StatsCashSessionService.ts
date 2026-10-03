import { supabase } from '../lib/supabase';

export type CashSessionCaptureStatus = 'open' | 'exact' | 'partial' | 'legacy_unavailable';

export interface ExactCashSession {
  session_id: string;
  club_id: string;
  table_id: string;
  cluster_id: string | null;
  variant: string | null;
  small_blind: number | null;
  big_blind: number | null;
  opened_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  duration_seconds: number | null;
  buyin_and_rebuys: number;
  final_cashout: number | null;
  session_result: number | null;
  capture_status: CashSessionCaptureStatus;
  capture_reason: string | null;
  hand_count: number | null;
  hand_net: number | null;
  hand_evidence_status: 'exact_facts' | 'overlap_unavailable';
  overlap: boolean;
  overlap_count: number;
  evidence: { kind: 'cash_session'; session_id: string };
}

export interface StatsCashSessionReport {
  contract_version: 2;
  scope: {
    target_user_id: string;
    club_id: string | null;
    asset: string;
    range_days: number | null;
    range_tz: string;
    visibility: 'owner';
  };
  coverage: {
    source: string;
    total_sessions: number;
    returned_sessions: number;
    capped: boolean;
  };
  sessions: ExactCashSession[];
  generated_at: string;
}

export const StatsCashSessionService = {
  async get(
    userId: string,
    clubId: string | null,
    days: number | null,
    timezone: string,
    asset: string,
    limit = 100
  ): Promise<StatsCashSessionReport> {
    const requestedLimit = Math.min(Math.max(Math.trunc(limit), 1), 250);
    const { data, error } = await supabase.rpc('ca_player_stats_cash_sessions', {
      p_user: userId,
      p_club_id: clubId,
      p_days: days,
      p_tz: timezone,
      p_asset: asset,
      p_limit: requestedLimit,
    });
    if (error) throw error;
    if (
      data?.contract_version !== 2 ||
      data?.scope?.target_user_id !== userId ||
      data?.scope?.club_id !== clubId ||
      data?.scope?.asset !== asset ||
      data?.scope?.range_days !== days ||
      data?.scope?.range_tz !== timezone ||
      data?.scope?.visibility !== 'owner' ||
      !Array.isArray(data?.sessions)
    ) {
      throw new Error('Cash Session Scope Mismatch');
    }
    return data as StatsCashSessionReport;
  },
};
