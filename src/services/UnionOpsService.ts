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

function finiteAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundMoney(value: number): number {
  return Math.round((value + Math.sign(value) * Number.EPSILON) * 100) / 100;
}

// Each component and the aggregate are rounded independently by PostgreSQL.
// Two half-cent component edges plus the aggregate's own half-cent edge can
// therefore differ by just under 1.5 cents without contradicting the source.
const DISTRIBUTION_ROUNDING_TOLERANCE = 0.015001;
const HALF_CENT_EDGE = 0.005001;

function sameRoundedMoney(left: number, right: number): boolean {
  return Math.abs(left - right) < DISTRIBUTION_ROUNDING_TOLERANCE;
}

function verifiedDistributionCheck(data: unknown, since?: string): DistributionCheck {
  const row = settlementRecord(data);
  const periodStart = row?.period_start;
  const rakeCollected = row?.rake_collected;
  const agentCommissions = row?.agent_commissions;
  const playerRakeback = row?.player_rakeback;
  const totalDistributed = row?.total_distributed;
  const overDistributedBy = row?.over_distributed_by;
  const healthy = row?.healthy;

  const expectedTotal =
    finiteAmount(agentCommissions) && finiteAmount(playerRakeback)
      ? roundMoney(agentCommissions + playerRakeback)
      : null;
  const expectedOver =
    finiteAmount(totalDistributed) && finiteAmount(rakeCollected)
      ? roundMoney(Math.max(totalDistributed - rakeCollected, 0))
      : null;
  const healthyCouldBeTrue =
    finiteAmount(totalDistributed) && finiteAmount(rakeCollected)
      ? totalDistributed - HALF_CENT_EDGE <= (rakeCollected + HALF_CENT_EDGE) * 1.001
      : false;
  const unhealthyCouldBeTrue =
    finiteAmount(totalDistributed) && finiteAmount(rakeCollected)
      ? totalDistributed + HALF_CENT_EDGE > (rakeCollected - HALF_CENT_EDGE) * 1.001
      : false;

  if (
    row === null ||
    !validPeriodBoundary(periodStart) ||
    (since !== undefined && Date.parse(periodStart) !== Date.parse(since)) ||
    !finiteAmount(rakeCollected) ||
    !finiteAmount(agentCommissions) ||
    !finiteAmount(playerRakeback) ||
    !finiteAmount(totalDistributed) ||
    !finiteAmount(overDistributedBy) ||
    overDistributedBy < 0 ||
    typeof healthy !== 'boolean' ||
    expectedTotal === null ||
    !sameRoundedMoney(totalDistributed, expectedTotal) ||
    expectedOver === null ||
    !sameRoundedMoney(overDistributedBy, expectedOver) ||
    (healthy ? !healthyCouldBeTrue : !unhealthyCouldBeTrue)
  ) {
    throw new Error('Union Distribution Reading Could Not Be Verified.');
  }

  return {
    period_start: periodStart,
    rake_collected: rakeCollected,
    agent_commissions: agentCommissions,
    player_rakeback: playerRakeback,
    total_distributed: totalDistributed,
    over_distributed_by: overDistributedBy,
    healthy,
  };
}

function verifiedLawFindings(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const findings: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    const finding = settlementRecord(entry);
    if (finding === null || Object.keys(finding).length === 0) return null;
    findings.push(finding);
  }
  return findings;
}

function verifiedLawSelfTest(data: unknown): LawSelfTest {
  const row = settlementRecord(data);
  const available = row?.available;
  const healthy = row?.healthy;
  const breaches = verifiedLawFindings(row?.breaches);
  const warnings = verifiedLawFindings(row?.warnings);
  const runStatus = row?.run_status;
  const startedAt = row?.started_at;
  const checkedAt = row?.checked_at;
  const note = row?.note;
  const timestampsValid =
    (startedAt === null || validPeriodBoundary(startedAt)) &&
    (checkedAt === null || validPeriodBoundary(checkedAt)) &&
    (startedAt === null || checkedAt === null || Date.parse(checkedAt) >= Date.parse(startedAt));

  // The stored self-test's `healthy` bit is breaches-only. Warnings still make
  // the console an attention state, but they do not contradict that producer
  // contract. An unavailable status is never a healthy verdict and carries no
  // cached findings that could be mistaken for the current run.
  const stateCoherent =
    typeof available === 'boolean' &&
    typeof healthy === 'boolean' &&
    breaches !== null &&
    warnings !== null &&
    typeof runStatus === 'string' &&
    runStatus.trim() !== '' &&
    timestampsValid &&
    (available
      ? runStatus === 'succeeded' &&
        startedAt !== null &&
        checkedAt !== null &&
        healthy === (breaches.length === 0)
      : healthy === false &&
        breaches.length === 0 &&
        warnings.length === 0 &&
        runStatus !== 'succeeded' &&
        typeof note === 'string' &&
        note.trim() !== '');

  if (row === null || !stateCoherent) {
    throw new Error('Union Law Audit Status Could Not Be Verified.');
  }

  return {
    available,
    healthy,
    breaches,
    warnings,
    run_status: runStatus,
    started_at: startedAt as string | null,
    checked_at: checkedAt as string | null,
    ...(typeof note === 'string' && note.trim() !== '' ? { note } : {}),
  };
}

function verifiedSettlementPreview(data: unknown, unionId: string): SettlementPreview {
  const preview = settlementRecord(data);
  const round1 = settlementRecord(preview?.round1);
  const round2 = settlementRecord(preview?.round2);
  const round3 = settlementRecord(preview?.round3);
  const money = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const moneyCents = (value: unknown): number | null =>
    money(value) ? Math.round((value as number) * 100) : null;
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
      const owed = moneyCents(row?.owed);
      const treasury = moneyCents(row?.treasury);
      const shortBy = moneyCents(row?.short_by);
      return (
        row !== null &&
        uuid(row.club_id) &&
        nullableDisplayName(row.club) &&
        owed !== null &&
        treasury !== null &&
        shortBy !== null &&
        shortBy > 0 &&
        shortBy === Math.max(owed - treasury, 0)
      );
    });
  const validRound3Detail =
    round3Detail !== null &&
    round3Detail.every((value) => {
      const row = settlementRecord(value);
      const owed = moneyCents(row?.owed);
      const agentBalance = moneyCents(row?.agent_balance);
      const shortBy = moneyCents(row?.short_by);
      return (
        row !== null &&
        uuid(row.agent_user_id) &&
        uuid(row.club_id) &&
        nullableDisplayName(row.agent) &&
        owed !== null &&
        agentBalance !== null &&
        shortBy !== null &&
        shortBy > 0 &&
        shortBy === Math.max(owed - agentBalance, 0)
      );
    });
  const round2PayeeCount = count(round2?.payees) ? (round2?.payees as number) : null;
  const round2ShortCount = count(round2?.clubs_short) ? (round2?.clubs_short as number) : null;
  const round3PayeeCount = count(round3?.payees) ? (round3?.payees as number) : null;
  const round3ShortCount = count(round3?.agents_short) ? (round3?.agents_short as number) : null;
  const blockerCount =
    round2ShortCount !== null && round3ShortCount !== null
      ? round2ShortCount + round3ShortCount
      : null;
  const round2DetailShortCents = round2Detail?.reduce(
    (sum, value) => sum + (moneyCents(settlementRecord(value)?.short_by) ?? 0),
    0
  );
  const round3DetailShortCents = round3Detail?.reduce(
    (sum, value) => sum + (moneyCents(settlementRecord(value)?.short_by) ?? 0),
    0
  );
  const round2ClubIds = round2Detail?.map((value) => settlementRecord(value)?.club_id);
  const round3AgentScopes = round3Detail?.map((value) => {
    const row = settlementRecord(value);
    return `${String(row?.club_id ?? '')}:${String(row?.agent_user_id ?? '')}`;
  });
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
    round2PayeeCount === null ||
    !money(round2.amount) ||
    round2ShortCount === null ||
    !money(round2.short_by) ||
    !validRound2Detail ||
    round2Detail?.length !== round2ShortCount ||
    round2ShortCount > round2PayeeCount ||
    round2DetailShortCents !== moneyCents(round2.short_by) ||
    new Set(round2ClubIds).size !== round2ClubIds?.length ||
    round3 === null ||
    round3PayeeCount === null ||
    !money(round3.amount) ||
    round3ShortCount === null ||
    !money(round3.short_by) ||
    !validRound3Detail ||
    round3Detail?.length !== round3ShortCount ||
    round3ShortCount > round3PayeeCount ||
    round3DetailShortCents !== moneyCents(round3.short_by) ||
    new Set(round3AgentScopes).size !== round3AgentScopes?.length ||
    !money(preview.total_to_move) ||
    moneyCents(preview.total_to_move) !==
      (moneyCents(round2.amount) ?? 0) + (moneyCents(round3.amount) ?? 0) ||
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

const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonnegativeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nullableName(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim() !== '');
}

function verifiedUnionCoverage(data: unknown): UnionCoverage {
  const row = settlementRecord(data);
  const policyBand = settlementRecord(row?.policy_band);
  const requireAgentForPlayers = row?.require_agent_for_players;
  const playersTotal = row?.players_total;
  const playersWithAgent = row?.players_with_agent;
  const playersWithoutAgent = row?.players_without_agent;
  const playerCoveragePct = row?.player_coverage_pct;
  const superAgents = row?.super_agents;
  const agents = row?.agents;
  const subAgents = row?.sub_agents;
  const agentsUnderSuper = row?.agents_under_a_super_agent;
  const agentsOrphaned = row?.agents_orphaned;
  const subAgentsUnderAgent = row?.sub_agents_under_an_agent;
  const subAgentsOrphaned = row?.sub_agents_orphaned;
  const agentsWithSubAgents = row?.agents_that_have_sub_agents;
  const commissionRatesOutOfPolicy = row?.commission_rates_out_of_policy;
  const playerRakebackDeals = row?.player_rakeback_deals;
  const playerRakebackGapBreaches = row?.player_rakeback_gap_breaches;
  const policyMin = policyBand?.min;
  const policyMax = policyBand?.max;
  if (
    row === null ||
    typeof requireAgentForPlayers !== 'boolean' ||
    !nonnegativeCount(playersTotal) ||
    !nonnegativeCount(playersWithAgent) ||
    !nonnegativeCount(playersWithoutAgent) ||
    !nonnegativeCount(superAgents) ||
    !nonnegativeCount(agents) ||
    !nonnegativeCount(subAgents) ||
    !nonnegativeCount(agentsUnderSuper) ||
    !nonnegativeCount(agentsOrphaned) ||
    !nonnegativeCount(subAgentsUnderAgent) ||
    !nonnegativeCount(subAgentsOrphaned) ||
    !nonnegativeCount(agentsWithSubAgents) ||
    !nonnegativeCount(commissionRatesOutOfPolicy) ||
    !nonnegativeCount(playerRakebackDeals) ||
    !nonnegativeCount(playerRakebackGapBreaches) ||
    !finiteAmount(playerCoveragePct) ||
    playerCoveragePct < 0 ||
    playerCoveragePct > 100 ||
    policyBand === null ||
    !finiteAmount(policyMin) ||
    !finiteAmount(policyMax) ||
    policyMin < 0 ||
    policyMax > 1 ||
    policyMin > policyMax
  ) {
    throw new Error('Union Hierarchy Coverage Could Not Be Verified.');
  }

  const expectedCoverage =
    playersTotal === 0 ? 100 : Math.round((1000 * playersWithAgent) / playersTotal) / 10;
  const activeAgents = superAgents + agents + subAgents;
  if (
    playersWithAgent > playersTotal ||
    playersWithoutAgent !== playersTotal - playersWithAgent ||
    Math.abs(playerCoveragePct - expectedCoverage) > Number.EPSILON ||
    agentsUnderSuper > agents ||
    agentsOrphaned !== agents - agentsUnderSuper ||
    subAgentsUnderAgent > subAgents ||
    subAgentsOrphaned !== subAgents - subAgentsUnderAgent ||
    agentsWithSubAgents > agents ||
    commissionRatesOutOfPolicy > activeAgents ||
    playerRakebackDeals > playersWithAgent ||
    playerRakebackGapBreaches > playerRakebackDeals
  ) {
    throw new Error('Union Hierarchy Coverage Could Not Be Verified.');
  }

  return {
    require_agent_for_players: requireAgentForPlayers,
    players_total: playersTotal,
    players_with_agent: playersWithAgent,
    players_without_agent: playersWithoutAgent,
    player_coverage_pct: playerCoveragePct,
    super_agents: superAgents,
    agents,
    sub_agents: subAgents,
    agents_under_a_super_agent: agentsUnderSuper,
    agents_orphaned: agentsOrphaned,
    sub_agents_under_an_agent: subAgentsUnderAgent,
    sub_agents_orphaned: subAgentsOrphaned,
    agents_that_have_sub_agents: agentsWithSubAgents,
    commission_rates_out_of_policy: commissionRatesOutOfPolicy,
    player_rakeback_deals: playerRakebackDeals,
    player_rakeback_gap_breaches: playerRakebackGapBreaches,
    policy_band: { min: policyMin, max: policyMax },
  };
}

function verifiedAgentRiskRows(value: unknown): AgentRiskRow[] {
  if (!Array.isArray(value)) {
    throw new Error('Union Agent Risk Reading Could Not Be Verified.');
  }
  return value.map((entry) => {
    const row = settlementRecord(entry);
    if (
      row === null ||
      typeof row.agent_user_id !== 'string' ||
      !UUID_VALUE.test(row.agent_user_id) ||
      !nullableName(row.agent_name) ||
      !nullableName(row.club_name) ||
      typeof row.role !== 'string' ||
      row.role.trim() === '' ||
      !nonnegativeCount(row.players) ||
      !nonnegativeCount(row.seated_now) ||
      row.seated_now > row.players ||
      !finiteAmount(row.rake_generated) ||
      !finiteAmount(row.player_net) ||
      !finiteAmount(row.commission_accrued) ||
      !finiteAmount(row.credit_extended)
    ) {
      throw new Error('Union Agent Risk Reading Could Not Be Verified.');
    }
    return {
      agent_user_id: row.agent_user_id,
      agent_name: row.agent_name,
      club_name: row.club_name,
      role: row.role,
      players: row.players,
      seated_now: row.seated_now,
      rake_generated: row.rake_generated,
      player_net: row.player_net,
      commission_accrued: row.commission_accrued,
      credit_extended: row.credit_extended,
    };
  });
}

function verifiedSettlementRounds(value: unknown, limit: number): SettlementRound[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error('Settlement Round Records Could Not Be Verified.');
  }
  return value.map((entry) => {
    const row = settlementRecord(entry);
    if (
      row === null ||
      !Number.isSafeInteger(row.round_no) ||
      (row.round_no as number) < 1 ||
      typeof row.round_name !== 'string' ||
      row.round_name.trim() === '' ||
      !nonnegativeCount(row.payees) ||
      !finiteAmount(row.amount) ||
      row.amount < 0 ||
      !nonnegativeCount(row.shortfalls) ||
      !validPeriodBoundary(row.executed_at) ||
      (row.detail !== null && settlementRecord(row.detail) === null)
    ) {
      throw new Error('Settlement Round Records Could Not Be Verified.');
    }
    return {
      round_no: row.round_no as number,
      round_name: row.round_name,
      payees: row.payees,
      amount: row.amount,
      shortfalls: row.shortfalls,
      executed_at: row.executed_at,
      detail: row.detail as Record<string, unknown> | null,
    };
  });
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
    return verifiedAgentRiskRows(data);
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
    return verifiedUnionCoverage(data);
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
    return verifiedSettlementRounds(data, limit);
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

  async getDistributionCheck(unionId: string, since?: string): Promise<DistributionCheck> {
    requireUnionId(unionId);
    if (since !== undefined && !validPeriodBoundary(since)) {
      throw new Error('Union Distribution Window Could Not Be Verified.');
    }
    const { data, error } = await supabase.rpc('fn_union_distribution_check', {
      p_union_id: unionId,
      p_since: since ?? null,
    });
    if (error) {
      reportError(error, 'UnionOpsService.getDistributionCheck');
      throw error;
    }
    return verifiedDistributionCheck(data, since);
  },

  // INTEGRITY & LAW
  async getLawSelfTest(): Promise<LawSelfTest> {
    // The full self-test is a scheduled global audit, not an interactive read.
    // Financial Admin reads the last persisted verdict in constant time.
    const { data, error } = await supabase.rpc('fn_union_law_selftest_status');
    if (error) {
      reportError(error, 'UnionOpsService.getLawSelfTest');
      throw error;
    }
    return verifiedLawSelfTest(data);
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
