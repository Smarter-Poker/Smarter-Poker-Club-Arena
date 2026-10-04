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
import { extractRawErrorText, safeErrorMessage } from '../utils/safeErrorMessage';

/* A union-scoped call names its union. Every method below used to default to
   one hardcoded union (Midway), and so did UnionOpsPanel, so a surface that
   had not resolved its union read, swept or settled that union's books instead
   of saying it had none. The constant is gone from the client; a missing id is
   refused before anything is asked of the database. */
function requireUnionId(unionId: string | null | undefined): void {
  if (typeof unionId !== 'string' || unionId.trim() === '') {
    throw new Error('No Union Selected');
  }
}

function settlementRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validPeriodBoundary(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:$|T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    calendar.getUTCFullYear() === Number(year) &&
    calendar.getUTCMonth() === Number(month) - 1 &&
    calendar.getUTCDate() === Number(day)
  );
}

function verifiedSettlementPreview(data: unknown, unionId: string): SettlementPreview {
  const preview = settlementRecord(data);
  const round1 = settlementRecord(preview?.round1);
  const round2 = settlementRecord(preview?.round2);
  const round3 = settlementRecord(preview?.round3);
  const money = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const uuid = (value: unknown) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const nullableDisplayName = (value: unknown) =>
    value === null || (typeof value === 'string' && value.trim() !== '');
  const round2Detail = Array.isArray(round2?.detail) ? round2.detail : null;
  const round3Detail = Array.isArray(round3?.detail) ? round3.detail : null;
  const validRound2Detail =
    round2Detail !== null &&
    round2Detail.every((value) => {
      const row = settlementRecord(value);
      return (
        row !== null &&
        uuid(row.club_id) &&
        nullableDisplayName(row.club) &&
        money(row.owed) &&
        money(row.treasury) &&
        money(row.short_by)
      );
    });
  const validRound3Detail =
    round3Detail !== null &&
    round3Detail.every((value) => {
      const row = settlementRecord(value);
      return (
        row !== null &&
        uuid(row.agent_user_id) &&
        uuid(row.club_id) &&
        nullableDisplayName(row.agent) &&
        money(row.owed) &&
        money(row.agent_balance) &&
        money(row.short_by)
      );
    });
  const round2ShortCount = count(round2?.clubs_short) ? (round2?.clubs_short as number) : null;
  const round3ShortCount = count(round3?.agents_short) ? (round3?.agents_short as number) : null;
  const blockerCount =
    round2ShortCount !== null && round3ShortCount !== null
      ? round2ShortCount + round3ShortCount
      : null;
  const validPeriod =
    validPeriodBoundary(preview?.period_start) &&
    validPeriodBoundary(preview?.period_end) &&
    Date.parse(preview.period_end) > Date.parse(preview.period_start);
  if (
    preview?.union_id !== unionId ||
    !validPeriod ||
    round1 === null ||
    typeof round1.already_executed !== 'boolean' ||
    !money(round1.rake_treasury_available) ||
    round2 === null ||
    !count(round2.payees) ||
    !money(round2.amount) ||
    !count(round2.clubs_short) ||
    !money(round2.short_by) ||
    !validRound2Detail ||
    round2Detail?.length !== round2.clubs_short ||
    round3 === null ||
    !count(round3.payees) ||
    !money(round3.amount) ||
    !count(round3.agents_short) ||
    !money(round3.short_by) ||
    !validRound3Detail ||
    round3Detail?.length !== round3.agents_short ||
    !money(preview.total_to_move) ||
    typeof preview.has_blockers !== 'boolean' ||
    blockerCount === null ||
    preview.has_blockers !== blockerCount > 0
  ) {
    throw new Error('Settlement Preview Could Not Be Verified For The Selected Union And Period.');
  }
  return data as SettlementPreview;
}

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

export interface OverseerUnionOption {
  id: string;
  name: string;
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
  available?: boolean;
  run_status?: string;
  started_at?: string | null;
  checked_at?: string | null;
  note?: string;
}

export interface IntegritySweepReceipt {
  union_id: string;
  window_hours: number;
  signals: number;
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
  const msg = extractRawErrorText(e) || 'Request failed';
  if (/not_authorised|not_authorized/i.test(msg)) {
    return 'You Do Not Have Permission To View This. Union Operations Are Visible To Union Owners And Admins.';
  }
  if (/permission denied/i.test(msg)) return 'You Do Not Have Permission To Do That.';
  if (/\b57014\b|statement timeout|canceling statement/i.test(msg)) {
    return 'That Took Too Long. Please Try Again.';
  }
  if (/fetch|network/i.test(msg)) return 'Connection Problem. Please Check Your Internet.';
  // Anything unrecognised goes through the allowlist sanitiser rather than
  // straight to the screen — this used to `return msg`, which put raw
  // PostgREST text in front of players. See utils/safeErrorMessage.ts.
  return safeErrorMessage(e, 'That Request Could Not Be Completed.');
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
  async getOverseerUnionOptions(): Promise<OverseerUnionOption[]> {
    const { data, error } = await supabase.rpc('fn_union_overseer_options');
    if (error) throw error;
    if (!Array.isArray(data)) {
      throw new Error('Authorized Union List Could Not Be Verified.');
    }
    const seen = new Set<string>();
    return data.map((value) => {
      const row = settlementRecord(value);
      const unionId = row?.union_id;
      const unionName = row?.union_name;
      if (
        typeof unionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unionId) ||
        typeof unionName !== 'string' ||
        unionName.trim() === '' ||
        seen.has(unionId)
      ) {
        throw new Error('Authorized Union List Could Not Be Verified.');
      }
      seen.add(unionId);
      return { id: unionId, name: unionName };
    });
  },

  async getAgentRisk(unionId: string, since?: string): Promise<AgentRiskRow[]> {
    requireUnionId(unionId);
    const { data, error } = await supabase.rpc('fn_union_agent_risk_report', {
      p_union_id: unionId,
      p_since: since ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getAgentRisk');
      throw error;
    }
    return (data ?? []) as AgentRiskRow[];
  },

  async getCoverage(unionId: string): Promise<UnionCoverage | null> {
    requireUnionId(unionId);
    const { data, error } = await supabase.rpc('fn_union_agent_coverage', { p_union_id: unionId });
    if (error) {
      reportError(error, 'UnionOpsService.getCoverage');
      return null;
    }
    return (data ?? null) as UnionCoverage | null;
  },

  /** Same read as getCoverage, but throws so the caller can show why it failed. */
  async getCoverageStrict(unionId: string): Promise<UnionCoverage | null> {
    requireUnionId(unionId);
    const { data, error } = await supabase.rpc('fn_union_agent_coverage', { p_union_id: unionId });
    if (error) throw error;
    return (data ?? null) as UnionCoverage | null;
  },

  async getAllAgentStatements(unionId: string, from?: string) {
    requireUnionId(unionId);
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
  async getSettlementRounds(unionId: string, limit = 30): Promise<SettlementRound[]> {
    requireUnionId(unionId);
    const { data, error } = await supabase
      .from('union_settlement_rounds')
      .select('round_no, round_name, payees, amount, shortfalls, executed_at, detail')
      .eq('union_id', unionId)
      .order('executed_at', { ascending: false })
      .limit(limit);
    if (error) {
      reportError(error, 'UnionOpsService.getSettlementRounds');
      throw error;
    }
    return (data ?? []).map((r) => ({
      ...r,
      amount: num((r as { amount: unknown }).amount),
    })) as SettlementRound[];
  },

  /** Read-only dry run: what each round WOULD move, and who cannot cover it. */
  async getSettlementPreview(
    unionId: string,
    from?: string,
    to?: string
  ): Promise<SettlementPreview> {
    requireUnionId(unionId);
    const { data, error } = await supabase.rpc('fn_union_settlement_preview', {
      p_union_id: unionId,
      p_period_start: from ?? null,
      p_period_end: to ?? null,
    });
    if (error) throw error;
    return verifiedSettlementPreview(data, unionId);
  },

  async getDistributionCheck(unionId: string, since?: string): Promise<DistributionCheck | null> {
    requireUnionId(unionId);
    const { data, error } = await supabase.rpc('fn_union_distribution_check', {
      p_union_id: unionId,
      p_since: since ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getDistributionCheck');
      throw error;
    }
    return (data ?? null) as DistributionCheck | null;
  },

  // INTEGRITY & LAW
  async getLawSelfTest(): Promise<LawSelfTest | null> {
    // The full self-test is a scheduled global audit, not an interactive read.
    // Financial Admin reads the last persisted verdict in constant time.
    const { data, error } = await supabase.rpc('fn_union_law_selftest_status');
    if (error) {
      reportError(error, 'UnionOpsService.getLawSelfTest');
      throw error;
    }
    return (data ?? null) as LawSelfTest | null;
  },

  async runIntegritySweep(unionId: string, hours = 24): Promise<IntegritySweepReceipt> {
    requireUnionId(unionId);
    const { data, error } = await supabase.rpc('fn_union_integrity_sweep', {
      p_union_id: unionId,
      p_hours: hours,
    });
    if (error) throw error;
    const receipt = settlementRecord(data);
    if (
      receipt?.union_id !== unionId ||
      receipt.window_hours !== hours ||
      !Number.isSafeInteger(receipt.signals) ||
      (receipt.signals as number) < 0
    ) {
      throw new Error('Integrity Sweep Could Not Be Verified For The Selected Union And Window.');
    }
    return {
      union_id: unionId,
      window_hours: hours,
      signals: receipt.signals as number,
    };
  },

  // GOVERNANCE
  async getClubExitBlockers(unionId: string, clubId: string): Promise<ExitBlockers | null> {
    requireUnionId(unionId);
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
    requireUnionId(unionId);
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
