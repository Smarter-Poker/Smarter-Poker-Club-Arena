/**
 * UNION OPS SERVICE
 *
 * Typed access to the union / agent-hierarchy capabilities that live in the
 * database. Every one of these was SQL-only before this service existed, so
 * nothing in the product could show them.
 *
 * Backing functions are all SECURITY DEFINER and authorisation-checked server
 * side: an agent may only pull their own roster, and the union views require
 * an overseer (union owner, union admin, or house-club owner/admin).
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';

export const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';

export interface AgentRosterRow {
  player_id: string;
  username: string | null;
  club_id: string;
  club_name: string | null;
  buyins: number;
  cashouts: number;
  net_result: number;
  rake_generated: number;
  agent_commission: number | null;
  chip_balance: number;
  credit_used: number;
  currently_seated: boolean;
}

export interface AgentStatement {
  agent_user_id: string;
  period_start: string;
  period_end: string;
  players: number;
  rake_generated: number;
  commission_earned: number;
  rakeback_passed_to_players: number;
  commission_net_of_rakeback: number;
  player_net_result: number;
  chips_issued_to_players: number;
  chips_returned_from_players: number;
  credit_outstanding: number;
  net_settlement_position: number | null;
  settlement_verified?: boolean;
  settlement_note?: string;
  club_ids?: string[];
}

export interface AgentRiskRow {
  agent_user_id: string;
  agent_name: string | null;
  club_name: string | null;
  role: string;
  players: number;
  seated_now: number;
  rake_generated: number;
  player_net: number;
  commission_accrued: number;
  credit_extended: number;
}

export interface UnionCoverage {
  require_agent_for_players: boolean;
  players_total: number;
  players_with_agent: number;
  players_without_agent: number;
  player_coverage_pct: number;
  super_agents: number;
  agents: number;
  sub_agents: number;
  agents_under_a_super_agent: number;
  agents_orphaned: number;
  sub_agents_under_an_agent: number;
  sub_agents_orphaned: number;
  agents_that_have_sub_agents: number;
  commission_rates_out_of_policy: number;
  player_rakeback_deals: number;
  player_rakeback_gap_breaches: number;
  policy_band: { min: number; max: number };
}

export interface SettlementRound {
  round_no: number;
  round_name: string;
  payees: number;
  amount: number;
  shortfalls: number;
  executed_at: string;
  detail: Record<string, unknown> | null;
}

export interface SettlementShortfall {
  club_id?: string;
  club?: string | null;
  agent_user_id?: string;
  agent?: string | null;
  owed: number;
  treasury?: number;
  agent_balance?: number;
  short_by: number;
}

export interface SettlementPreview {
  union_id: string;
  period_start: string;
  period_end: string;
  round1: { already_executed: boolean; rake_treasury_available: number };
  round2: {
    payees: number;
    amount: number;
    clubs_short: number;
    short_by: number;
    detail: SettlementShortfall[];
  };
  round3: {
    payees: number;
    amount: number;
    agents_short: number;
    short_by: number;
    detail: SettlementShortfall[];
  };
  total_to_move: number;
  has_blockers: boolean;
}

export interface DistributionCheck {
  period_start: string;
  rake_collected: number;
  agent_commissions: number;
  player_rakeback: number;
  total_distributed: number;
  over_distributed_by: number;
  healthy: boolean;
}

export interface LawSelfTest {
  healthy: boolean;
  breaches: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
}

export interface ExitBlockers {
  players_seated_in_union_games: number;
  live_tournament_entries: number;
  unsettled_rake_this_period: number;
  agent_credit_outstanding: number;
  clear_to_exit: boolean;
}

/**
 * Read failures used to be swallowed into an empty array, so the UI could not
 * tell "this union has no agents" from "you are not allowed to see this" from
 * "the request failed". Reads now return this alongside the data.
 */
export type LoadResult<T> = { data: T; error: string | null };

export function describeRpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'Request failed');
  if (/not_authorised|not_authorized/i.test(msg)) {
    return 'You do not have permission to view this. Union operations are visible to union owners and admins.';
  }
  if (/permission denied/i.test(msg)) return 'You do not have permission to do that.';
  if (/fetch|network/i.test(msg)) return 'Connection problem. Please check your internet.';
  // Anything unrecognised goes through the allowlist sanitiser rather than
  // straight to the screen — this used to `return msg`, which put raw
  // PostgREST text in front of players. See utils/safeErrorMessage.ts.
  return safeErrorMessage(e, 'That request could not be completed.');
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const UnionOpsService = {
  // AGENT BACK OFFICE
  async getAgentRoster(
    agentUserId?: string,
    since?: string,
    until?: string,
    clubId?: string
  ): Promise<AgentRosterRow[]> {
    const { data, error } = await supabase.rpc('fn_agent_roster_report', {
      p_agent_user_id: agentUserId ?? null,
      p_since: since ?? null,
      p_until: until ?? null,
      p_club_id: clubId ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getAgentRoster');
      throw new Error(error.message || 'Agent roster unavailable');
    }
    return (data ?? []) as AgentRosterRow[];
  },

  async getAgentStatement(
    agentUserId?: string,
    from?: string,
    to?: string,
    clubId?: string
  ): Promise<AgentStatement | null> {
    const { data, error } = await supabase.rpc('fn_agent_weekly_statement', {
      p_agent_user_id: agentUserId ?? null,
      p_period_start: from ?? null,
      p_period_end: to ?? null,
      p_club_id: clubId ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getAgentStatement');
      throw new Error(error.message || 'Agent statement unavailable');
    }
    return (data ?? null) as AgentStatement | null;
  },

  // UNION OVERSIGHT
  async getAgentRisk(unionId: string = MIDWAY_UNION_ID, since?: string): Promise<AgentRiskRow[]> {
    const { data, error } = await supabase.rpc('fn_union_agent_risk_report', {
      p_union_id: unionId,
      p_since: since ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getAgentRisk');
      return [];
    }
    return (data ?? []) as AgentRiskRow[];
  },

  async getCoverage(unionId: string = MIDWAY_UNION_ID): Promise<UnionCoverage | null> {
    const { data, error } = await supabase.rpc('fn_union_agent_coverage', { p_union_id: unionId });
    if (error) {
      reportError(error, 'UnionOpsService.getCoverage');
      return null;
    }
    return (data ?? null) as UnionCoverage | null;
  },

  /** Same read as getCoverage, but throws so the caller can show why it failed. */
  async getCoverageStrict(unionId: string = MIDWAY_UNION_ID): Promise<UnionCoverage | null> {
    const { data, error } = await supabase.rpc('fn_union_agent_coverage', { p_union_id: unionId });
    if (error) throw error;
    return (data ?? null) as UnionCoverage | null;
  },

  async getAllAgentStatements(unionId: string = MIDWAY_UNION_ID, from?: string) {
    const { data, error } = await supabase.rpc('fn_union_weekly_agent_statements', {
      p_union_id: unionId,
      p_period_start: from ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getAllAgentStatements');
      return [];
    }
    return (data ?? []) as Array<{
      agent_user_id: string;
      agent_name: string | null;
      club_name: string | null;
      statement: AgentStatement;
    }>;
  },

  // SETTLEMENT
  async getSettlementRounds(
    unionId: string = MIDWAY_UNION_ID,
    limit = 30
  ): Promise<SettlementRound[]> {
    const { data, error } = await supabase
      .from('union_settlement_rounds')
      .select('round_no, round_name, payees, amount, shortfalls, executed_at, detail')
      .eq('union_id', unionId)
      .order('executed_at', { ascending: false })
      .limit(limit);
    if (error) {
      reportError(error, 'UnionOpsService.getSettlementRounds');
      return [];
    }
    return (data ?? []).map((r) => ({
      ...r,
      amount: num((r as { amount: unknown }).amount),
    })) as SettlementRound[];
  },

  /** Read-only dry run: what each round WOULD move, and who cannot cover it. */
  async getSettlementPreview(
    unionId: string = MIDWAY_UNION_ID,
    from?: string,
    to?: string
  ): Promise<SettlementPreview> {
    const { data, error } = await supabase.rpc('fn_union_settlement_preview', {
      p_union_id: unionId,
      p_period_start: from ?? null,
      p_period_end: to ?? null,
    });
    if (error) throw error;
    return data as SettlementPreview;
  },

  async runSettlementCascade(unionId: string = MIDWAY_UNION_ID, from?: string, to?: string) {
    const { data, error } = await supabase.rpc('fn_union_settlement_cascade', {
      p_union_id: unionId,
      p_period_start: from ?? null,
      p_period_end: to ?? null,
    });
    if (error) throw error;
    return data as Record<string, unknown>;
  },

  async getDistributionCheck(
    unionId: string = MIDWAY_UNION_ID,
    since?: string
  ): Promise<DistributionCheck | null> {
    const { data, error } = await supabase.rpc('fn_union_distribution_check', {
      p_union_id: unionId,
      p_since: since ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getDistributionCheck');
      return null;
    }
    return (data ?? null) as DistributionCheck | null;
  },

  // INTEGRITY & LAW
  async getLawSelfTest(): Promise<LawSelfTest | null> {
    const { data, error } = await supabase.rpc('fn_union_law_selftest');
    if (error) {
      reportError(error, 'UnionOpsService.getLawSelfTest');
      return null;
    }
    return (data ?? null) as LawSelfTest | null;
  },

  async runIntegritySweep(unionId: string = MIDWAY_UNION_ID, hours = 24) {
    const { data, error } = await supabase.rpc('fn_union_integrity_sweep', {
      p_union_id: unionId,
      p_hours: hours,
    });
    if (error) throw error;
    return data as Record<string, unknown>;
  },

  // GOVERNANCE
  async getClubExitBlockers(unionId: string, clubId: string): Promise<ExitBlockers | null> {
    const { data, error } = await supabase.rpc('fn_union_club_exit_blockers', {
      p_union_id: unionId,
      p_club_id: clubId,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getClubExitBlockers');
      return null;
    }
    return (data ?? null) as ExitBlockers | null;
  },

  async expelClub(unionId: string, clubId: string, reason?: string, force = false) {
    const { data, error } = await supabase.rpc('fn_union_expel_club', {
      p_union_id: unionId,
      p_club_id: clubId,
      p_reason: reason ?? null,
      p_force: force,
    });
    if (error) throw error;
    return data as { success: boolean; error?: string; blockers?: ExitBlockers };
  },

  async assignPlayerToAgent(playerUserId: string, agentUserId: string, clubId: string) {
    const { data, error } = await supabase.rpc('fn_assign_player_to_agent', {
      p_player_user_id: playerUserId,
      p_agent_user_id: agentUserId,
      p_club_id: clubId,
    });
    if (error) throw error;
    return data as { success: boolean; error?: string };
  },

  async assignAgentToSuperAgent(agentUserId: string, superAgentUserId: string, clubId: string) {
    const { data, error } = await supabase.rpc('fn_assign_agent_to_super_agent', {
      p_agent_user_id: agentUserId,
      p_super_agent_user_id: superAgentUserId,
      p_club_id: clubId,
    });
    if (error) throw error;
    return data as { success: boolean; error?: string };
  },
};

export default UnionOpsService;
