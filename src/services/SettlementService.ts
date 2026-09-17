/** Browser settlement reads. Automatic weekly writes belong to the canonical coordinator. */
import { supabase } from '../lib/supabase';
import { captureWeeklyAccountingAccount } from './ClubWeeklyAccountingReader';
import {
  accountingInstant,
  isAccountingUUID,
  type AccountingScopeKind,
} from './AccountingObservationService';

export class AutomaticWeeklyAccountingOnlyError extends Error {
  readonly code = 'automatic_weekly_accounting_only';
  constructor() {
    super('Weekly accounting runs automatically. Refresh its recorded status.');
  }
}
export class CanonicalWeeklyStatementsRequiredError extends Error {
  readonly code = 'canonical_weekly_statements_required';
  constructor() {
    super(
      'Use issued weekly accounting statements. This historical report cannot verify its complete scope.'
    );
  }
}
export interface SettlementReadScope {
  scopeKind: AccountingScopeKind;
  scopeId: string;
  actorId?: string;
  isCurrent?: () => boolean;
}
const unavailable = () => new Error('Settlement Records Are Unavailable');
function scopedRead(input?: SettlementReadScope) {
  if (!input || !['club', 'union'].includes(input.scopeKind) || !isAccountingUUID(input.scopeId))
    throw unavailable();
  const scope = { ...input, scopeId: input.scopeId.toLowerCase() };
  const account = captureWeeklyAccountingAccount(scope.actorId);
  const current = () => {
    if (!account.isCurrent() || (scope.isCurrent && !scope.isCurrent())) throw unavailable();
  };
  current();
  return { scope, current };
}
const periodFields =
  'id,club_id,union_id,period_number,year,start_at,end_at,status,total_rake_collected::text,total_bbj_contributions::text,total_player_winnings::text,total_player_losses::text,total_hands_dealt,settled_at,settled_by';
function integer(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}
/** Captured period columns are numeric(15,2); null remains unavailable, never zero. */
function periodAmount(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,12})\.\d{2}$/.test(value))
    throw unavailable();
  const cents = BigInt(value.replace('.', ''));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER))
    throw unavailable();
  const amount = Number(value);
  if (!Number.isFinite(amount) || BigInt(Math.round(amount * 100)) !== cents) throw unavailable();
  return amount;
}
function periodRecord(value: unknown, scope?: SettlementReadScope): SettlementPeriod {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const p = value as Record<string, unknown>;
  if (
    !isAccountingUUID(p.id) ||
    typeof p.status !== 'string' ||
    !['open', 'processing', 'settled', 'disputed', 'closed'].includes(String(p.status)) ||
    accountingInstant(p.end_at) <= accountingInstant(p.start_at)
  )
    throw unavailable();
  const kind =
    p.club_id === null && isAccountingUUID(p.union_id)
      ? 'union'
      : p.union_id === null && isAccountingUUID(p.club_id)
        ? 'club'
        : null;
  if (!kind || (scope && (kind !== scope.scopeKind || p[`${kind}_id`] !== scope.scopeId)))
    throw unavailable();
  if (p.settled_at !== null) accountingInstant(p.settled_at);
  if (p.settled_by !== null && !isAccountingUUID(p.settled_by)) throw unavailable();
  return {
    id: p.id,
    scope: kind,
    clubId: p.club_id as string | null,
    unionId: p.union_id as string | null,
    periodNumber: integer(p.period_number) as number,
    year: integer(p.year) as number,
    startAt: p.start_at as string,
    endAt: p.end_at as string,
    status: p.status as SettlementStatus,
    totalRakeCollected: periodAmount(p.total_rake_collected),
    totalBBJContributions: periodAmount(p.total_bbj_contributions),
    totalPlayerWinnings: periodAmount(p.total_player_winnings),
    totalPlayerLosses: periodAmount(p.total_player_losses),
    totalHandsDealt: integer(p.total_hands_dealt, true),
    settledAt: (p.settled_at as string | null) ?? undefined,
    settledBy: (p.settled_by as string | null) ?? undefined,
  };
}
function periodQuery(scope: SettlementReadScope) {
  return supabase
    .from('settlement_periods')
    .select(periodFields)
    .eq(`${scope.scopeKind}_id`, scope.scopeId)
    .is(scope.scopeKind === 'club' ? 'union_id' : 'club_id', null);
}

export type SettlementStatus = 'open' | 'processing' | 'settled' | 'disputed' | 'closed';

export interface SettlementPeriod {
  id: string;
  /** Recorded scope; status is not a canonical payment receipt. */
  scope?: 'club' | 'union';
  clubId?: string | null;
  unionId?: string | null;
  periodNumber: number;
  year: number;
  startAt: string;
  endAt: string;
  status: SettlementStatus;
  totalRakeCollected: number | null;
  totalBBJContributions: number | null;
  totalPlayerWinnings: number | null;
  totalPlayerLosses: number | null;
  totalHandsDealt: number | null;
  settledAt?: string;
  settledBy?: string;
}

export interface ClubSettlement {
  id: string;
  periodId: string;
  clubId: string;
  clubName: string;
  totalRakeCollected: number;
  totalJackpotContributions: number;
  totalPromoCosts: number;
  uniquePlayers: number;
  totalHandsDealt: number;
  platformFee: number;
  agentCommissions: number;
  grossRevenue: number;
  netRevenue: number;
  status: 'pending' | 'finalized' | 'disputed';
}

export interface AgentSettlement {
  id: string;
  periodId: string;
  agentId: string;
  agentName: string;
  totalRakeGenerated: number;
  commissionRate: number;
  commissionEarned: number;
  creditExtended: number;
  creditRepaid: number;
  netSettlement: number;
  activePlayers: number;
  status: 'pending' | 'approved' | 'paid' | 'disputed';
}

export interface UnionWireCalculation {
  clubId: string;
  clubName: string;
  netPlayerPL: number;
  grossRake: number;
  unionTax: number;
  finalWire: number;
  action: 'COLLECT_FROM_UNION' | 'PAY_TO_UNION';
}

export interface SettlementSummary {
  period: SettlementPeriod;
  clubSettlements: ClubSettlement[];
  agentSettlements: AgentSettlement[];
  unionWires: UnionWireCalculation[];
  totalPlatformRevenue: number;
  totalAgentPayouts: number;
  totalPlayerRakeback: number;
}

export const SettlementService = {
  async getCurrentPeriodForClub(_clubId: string): Promise<SettlementPeriod | null> {
    throw new AutomaticWeeklyAccountingOnlyError();
  },
  async getCurrentPeriod(): Promise<SettlementPeriod> {
    throw new AutomaticWeeklyAccountingOnlyError();
  },
  async closePeriod(_periodId: string): Promise<boolean> {
    throw new AutomaticWeeklyAccountingOnlyError();
  },
  async executeMondayPayouts(
    _periodId: string
  ): Promise<{ agentsPaid: number; playersWithRakeback: number; totalDisbursed: number }> {
    throw new AutomaticWeeklyAccountingOnlyError();
  },
  async runPendingRakebackSettlement(_maxClubs = 100): Promise<{
    clubsProcessed: number;
    periodsSettled: number;
    totalPayout: number;
    clubsRemaining: number;
  }> {
    throw new AutomaticWeeklyAccountingOnlyError();
  },
  async executeUnionRakeBack(
    _unionId: string,
    _periodStart: string,
    _periodEnd: string
  ): Promise<{ clubsPaid: number; totalRakeBack: number; unionRetained: number }> {
    throw new AutomaticWeeklyAccountingOnlyError();
  },

  /** No global fallback. Bounded records are not payment or completion attestations. */
  async getPeriodHistory(limit = 12, requested?: SettlementReadScope): Promise<SettlementPeriod[]> {
    const { scope, current } = scopedRead(requested);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw unavailable();
    const { data, error } = await periodQuery(scope)
      .order('start_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    current();
    if (error || !Array.isArray(data) || data.length > limit) throw unavailable();
    const rows = data.map((row) => periodRecord(row, scope));
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw unavailable();
    current();
    return rows;
  },
  async getPeriodRecord(
    periodId: string,
    requested?: SettlementReadScope
  ): Promise<SettlementPeriod> {
    const { scope, current } = scopedRead(requested);
    if (!isAccountingUUID(periodId)) throw unavailable();
    const { data, error } = await periodQuery(scope).eq('id', periodId.toLowerCase()).maybeSingle();
    current();
    if (error) throw unavailable();
    const row = periodRecord(data, scope);
    if (row.id !== periodId.toLowerCase()) throw unavailable();
    return row;
  },
  calculateUnionWire(
    clubId: string,
    clubName: string,
    netPlayerPL: number,
    grossRake: number,
    // RAKE-AUDIT 2026-07-24: union revenue share is now configurable — the
    // union.settings.revenueSharePercent value was stored but IGNORED (the tax
    // was hardcoded 10%). Callers may pass the union's configured percent;
    // default stays 10 for backwards compatibility.
    unionTaxPercent: number = 10
  ): UnionWireCalculation {
    const pct = Number.isFinite(unionTaxPercent) && unionTaxPercent >= 0 ? unionTaxPercent : 10;
    const unionTax = Math.round(grossRake * (pct / 100) * 100) / 100;
    const finalWire = netPlayerPL + grossRake - unionTax;

    return {
      clubId,
      clubName,
      netPlayerPL,
      grossRake,
      unionTax,
      finalWire,
      action: finalWire >= 0 ? 'COLLECT_FROM_UNION' : 'PAY_TO_UNION',
    };
  },

  /** Historical report RPCs do not prove complete union/agent scope. Never dispatch them. */
  async generateSettlements(
    _periodId: string,
    _scope?: SettlementReadScope
  ): Promise<SettlementSummary> {
    throw new CanonicalWeeklyStatementsRequiredError();
  },
  async calculateAgentSettlement(
    _periodId: string,
    _agentId: string,
    _scope?: SettlementReadScope
  ): Promise<AgentSettlement> {
    throw new CanonicalWeeklyStatementsRequiredError();
  },
  /** Historical backlog diagnostics are retained; unavailable is never a zero debt. */
  async getRakebackSettlementStatus(): Promise<{
    pendingPeriods: number;
    pendingClubs: number;
    estimatedOwed: number;
    lastPaidAt: string | null;
  } | null> {
    const account = captureWeeklyAccountingAccount();
    const { data, error } = await supabase.rpc('fn_rakeback_settlement_status');
    if (!account.isCurrent()) throw unavailable();
    if (error || data?.success !== true) return null;
    const pendingPeriods = integer(data.pending_periods),
      pendingClubs = integer(data.pending_clubs);
    if (
      typeof data.estimated_owed !== 'number' ||
      !Number.isFinite(data.estimated_owed) ||
      data.estimated_owed < 0
    )
      throw unavailable();
    if (data.last_paid_at !== null) accountingInstant(data.last_paid_at);
    return {
      pendingPeriods: pendingPeriods as number,
      pendingClubs: pendingClubs as number,
      estimatedOwed: data.estimated_owed,
      lastPaidAt: data.last_paid_at,
    };
  },
  async getClubReport(_clubId: string, _periodId?: string): Promise<ClubSettlement | null> {
    throw new CanonicalWeeklyStatementsRequiredError();
  },
  async getAgentReport(
    _agentId: string,
    _periodId?: string,
    _scope?: SettlementReadScope
  ): Promise<AgentSettlement | null> {
    throw new CanonicalWeeklyStatementsRequiredError();
  },
  mapPeriod(p: unknown): SettlementPeriod {
    return periodRecord(p);
  },
  mapClubSettlement(s: any): ClubSettlement {
    return {
      id: s.id,
      periodId: s.period_id,
      clubId: s.club_id,
      clubName: s.club_name || 'Unknown Club',
      totalRakeCollected: s.total_rake_collected,
      totalJackpotContributions: s.total_jackpot_contributions,
      totalPromoCosts: s.total_promo_costs,
      uniquePlayers: s.unique_players,
      totalHandsDealt: s.total_hands_dealt,
      platformFee: s.platform_fee,
      agentCommissions: s.agent_commissions,
      grossRevenue: s.gross_revenue,
      netRevenue: s.net_revenue,
      status: s.status,
    };
  },

  mapAgentSettlement(s: any): AgentSettlement {
    return {
      id: s.id,
      periodId: s.period_id,
      agentId: s.agent_id,
      agentName: s.agent_name || 'Unknown Agent',
      totalRakeGenerated: s.total_rake_generated,
      commissionRate: s.commission_rate,
      commissionEarned: s.commission_earned,
      creditExtended: s.total_credit_extended || 0,
      creditRepaid: s.total_credit_repaid || 0,
      netSettlement: s.net_settlement,
      activePlayers: s.active_players || 0,
      status: s.status,
    };
  },
};
export default SettlementService;
