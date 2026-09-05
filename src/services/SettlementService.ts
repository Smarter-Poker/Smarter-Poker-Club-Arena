/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT SERVICE — Weekly Financial Settlement Automation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles Union Cross-Club Wires and Monday Payouts.
 *
 * SETTLEMENT CYCLE:
 * - Sunday 11:59:59 PM PST → Snapshot all ledgers
 * - Monday 4:00 AM PST → Process payouts
 *
 * FORMULA:
 * Wire = (Net Player P/L) + (Gross Rake Return) - (Union Tax 10%)
 */

import { supabase } from '../lib/supabase';
import { CommissionService } from './CommissionService';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { retryAsync } from '../utils/retryAsync';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
// Use globalThis.crypto for browser-safe UUID generation
const generateUUID = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SettlementStatus = 'open' | 'processing' | 'settled' | 'disputed';

export interface SettlementPeriod {
  id: string;
  /**
   * Whose period this is. 'club' is the club's own; 'union' means the club has
   * none of its own and this is the union's open period, shown as such.
   * Undefined for the unscoped platform-wide lookup.
   */
  scope?: 'club' | 'union';
  clubId?: string | null;
  unionId?: string | null;
  periodNumber: number;
  year: number;
  startAt: string;
  endAt: string;
  status: SettlementStatus;
  totalRakeCollected: number;
  totalBBJContributions: number;
  totalPlayerWinnings: number;
  totalPlayerLosses: number;
  totalHandsDealt: number;
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

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const SettlementService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // PERIOD MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * THE PERIOD THIS CLUB IS IN (2026-09-05, phase 7).
   *
   * `get_current_settlement_period(club)` answers for one club: its own open
   * period, else its own work still in flight, else its union's open period
   * marked as the union's. Null when the club has none - which is the honest
   * answer for a club that has never been settled, and is what the reference
   * club returns today.
   *
   * The no-argument `getCurrentPeriod()` below is unchanged and still serves
   * the union surfaces. It asks for the newest OPEN period on the platform
   * regardless of club, which is why heading a club page with it showed every
   * club the same period - one that today belongs to no club at all
   * (club_id NULL, union-scoped, three weeks stale).
   */
  async getCurrentPeriodForClub(clubId: string): Promise<SettlementPeriod | null> {
    const { data, error } = await supabase.rpc('get_current_settlement_period', {
      p_club_id: clubId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id) return null;
    return {
      id: row.id,
      scope: row.scope === 'union' ? 'union' : 'club',
      clubId: row.club_id ?? null,
      unionId: row.union_id ?? null,
      // Every one of these is a real column on settlement_periods. They used
      // to be hardcoded here - periodNumber 1, this year, and four zeroes -
      // which is what drew "Period 1/2026" over a grid of zeros.
      periodNumber: Number(row.period_number) || 0,
      year: Number(row.year) || new Date().getFullYear(),
      startAt: row.period_start,
      endAt: row.period_end,
      status: (row.status || 'open') as SettlementStatus,
      totalRakeCollected: Number(row.total_rake) || 0,
      totalBBJContributions: Number(row.total_bbj) || 0,
      totalPlayerWinnings: Number(row.total_player_winnings) || 0,
      totalPlayerLosses: Number(row.total_player_losses) || 0,
      totalHandsDealt: Number(row.total_hands_dealt) || 0,
      settledAt: row.settled_at ?? undefined,
    };
  },

  /**
   * Get or create the current settlement period, platform-wide.
   *
   * NOT club-scoped: it returns the newest open period whoever asks. Use
   * getCurrentPeriodForClub() on any club surface.
   */
  async getCurrentPeriod(): Promise<SettlementPeriod> {
    const { data, error } = await retryAsync(
      () => supabase.rpc('get_current_settlement_period'),
      3
    );
    if (error) throw error;

    // The RPC is a SECURITY DEFINER get-or-create: it always returns a real,
    // persisted open period (selecting the current one or inserting a new one).
    // We must NEVER fabricate a random-UUID period here — nothing backs it, so
    // every settlement written against it is orphaned.
    if (data && data.length > 0) {
      const period = data[0];
      if (!period.id) {
        throw new Error(
          '[Settlement] get_current_settlement_period returned a row with no id - refusing to fabricate an orphaned period.'
        );
      }
      return {
        id: period.id,
        periodNumber: 1,
        year: new Date().getFullYear(),
        startAt: period.period_start,
        endAt: period.period_end,
        status: period.status || 'open',
        totalRakeCollected: period.total_rake || 0,
        totalBBJContributions: 0,
        totalPlayerWinnings: 0,
        totalPlayerLosses: 0,
        totalHandsDealt: 0,
      };
    }

    // Empty result now means a genuine backend failure (the get-or-create RPC
    // should always return a period). Fail loudly rather than orphan a settlement.
    throw new Error(
      '[Settlement] get_current_settlement_period returned no rows - settlement period unavailable.'
    );
  },

  /**
   * Get historical periods
   */
  async getPeriodHistory(limit: number = 12, clubId?: string): Promise<SettlementPeriod[]> {
    // 2026-08-19: this had NO club scoping, so a page rendering "this club's
    // settlement history" actually rendered whatever periods RLS happened to
    // let the viewer see — for a union admin, every club in the union, mixed
    // together with no way to tell them apart. RLS contained it, but the list
    // was still wrong. Callers that know their club should pass it.
    let query = supabase
      .from('settlement_periods')
      .select(
        'id, club_id, period_number, year, start_at, end_at, status, total_rake_collected, total_bbj_contributions, total_player_winnings, total_player_losses, total_hands_dealt, settled_at, settled_by'
      );

    if (clubId) query = query.eq('club_id', clubId);

    const { data, error } = await query.order('start_at', { ascending: false }).limit(limit);

    if (error) throw error;
    return data.map(this.mapPeriod);
  },

  /**
   * Close period and begin processing
   */
  async closePeriod(periodId: string): Promise<boolean> {
    // settlement_periods is service-role-write-only; a direct update silently
    // affects 0 rows. Go through the authorized RPC.
    const { data, error } = await supabase.rpc('fn_set_settlement_period_status', {
      p_period_id: periodId,
      p_status: 'processing',
    });
    if (error) throw error;
    const r = data as { success?: boolean; error?: string } | null;
    if (r && r.success === false) throw new Error(r.error || 'Failed to close period');
    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SETTLEMENT CALCULATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate union wire for a club
   */
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

  /**
   * Generate all settlements for a period.
   *
   * SWEEP #3 (2026-07-23): the `generate_period_settlements` RPC is no longer a
   * stub — it is a real SECURITY DEFINER read model computed over the live
   * tables (settlement_periods, rake_history, bbj_contributions,
   * agent_commissions, rakeback_periods, settlement_invoices) and returns the
   * full camelCase SettlementSummary shape. Read-only; it moves no money.
   */
  async generateSettlements(periodId: string): Promise<SettlementSummary> {
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('generate_period_settlements', {
          p_period_id: periodId,
        }),
      3
    );

    if (error) throw error;
    return data;
  },

  /**
   * Calculate agent settlement for a specific agent.
   *
   * SWEEP #3 (2026-07-23): `calculate_agent_settlement` is reimplemented
   * server-side over agents + agent_commissions (the live per-hand commission
   * ledger written by the engine RakebackSettler) and returns the camelCase
   * AgentSettlement shape directly.
   */
  async calculateAgentSettlement(periodId: string, agentId: string): Promise<AgentSettlement> {
    try {
      const { data, error } = await retryAsync(
        () =>
          supabase.rpc('calculate_agent_settlement', {
            p_period_id: periodId,
            p_agent_id: agentId,
          }),
        3
      );

      if (error) {
        reportError(error, 'SettlementService.calculateAgentSettlement', { periodId, agentId });
        // Return default if the RPC fails (e.g. caller not authorized)
        return {
          id: `${agentId}-${periodId}`,
          periodId,
          agentId,
          agentName: 'Unknown',
          totalRakeGenerated: 0,
          commissionRate: 0,
          commissionEarned: 0,
          creditExtended: 0,
          creditRepaid: 0,
          netSettlement: 0,
          activePlayers: 0,
          status: 'pending',
        };
      }
      return data;
    } catch (err: unknown) {
      reportError(err, 'SettlementService.calculateAgentSettlement.exception', {
        periodId,
        agentId,
      });
      throw err;
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // PAYOUT EXECUTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute Monday payout cycle
   */
  async executeMondayPayouts(periodId: string): Promise<{
    agentsPaid: number;
    playersWithRakeback: number;
    totalDisbursed: number;
  }> {
    // DEPRECATED / RETIRED (2026-07-21). This Monday-payout runner read two tables
    // that were DELIBERATELY REMOVED from the schema — `agent_settlements` and
    // `player_weekly_snapshots` — and its `calculate_agent_settlement` RPC is a stub
    // ("agent_settlements table removed"). It has therefore been a silent no-op
    // (errors on the missing tables were swallowed). The LIVE payout paths are:
    //   - Agent commissions -> the credit_invoices subsystem
    //     (fn_generate_credit_invoice / fn_apply_credit_payment, see CreditService).
    //   - Player rakeback   -> the engine's durable RakebackSettlerService daemon on
    //     Hetzner (settles rakeback_periods / player_stats behind a persisted
    //     high-water-mark watermark).
    // Kept as a pure no-op so existing callers (SettlementCronService with
    // autoExecutePayouts, useUnionStore) resolve cleanly; it moves no money. Do not
    // build on it — see .agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md.
    console.debug(
      `[Settlement] executeMondayPayouts is retired (no-op) for period ${periodId} - ` +
        'agent payouts flow through credit_invoices; player rakeback through the engine ' +
        'RakebackSettlerService.'
    );
    return { agentsPaid: 0, playersWithRakeback: 0, totalDisbursed: 0 };
  },

  /**
   * Admin-only status of the player-rakeback settlement backlog. The engine
   * daemon settles rakeback automatically; this surfaces what's still pending so
   * the dashboard can stop pretending and show real numbers.
   */
  async getRakebackSettlementStatus(): Promise<{
    pendingPeriods: number;
    pendingClubs: number;
    estimatedOwed: number;
    lastPaidAt: string | null;
  } | null> {
    const { data, error } = await supabase.rpc('fn_rakeback_settlement_status');
    if (error || !data?.success) {
      if (error) reportError(error, 'SettlementService.getRakebackSettlementStatus');
      return null;
    }
    return {
      pendingPeriods: Number(data.pending_periods || 0),
      pendingClubs: Number(data.pending_clubs || 0),
      estimatedOwed: Number(data.estimated_owed || 0),
      lastPaidAt: data.last_paid_at || null,
    };
  },

  /**
   * Admin-only on-demand player-rakeback settlement. Drives the existing
   * idempotent settle_club_rakeback per club (status-guard + receipt table), so
   * it is safe to run any time and cannot double-pay. Bounded per call.
   */
  async runPendingRakebackSettlement(maxClubs = 100): Promise<{
    clubsProcessed: number;
    periodsSettled: number;
    totalPayout: number;
    clubsRemaining: number;
  }> {
    const { data, error } = await supabase.rpc('fn_run_pending_rakeback_settlement', {
      p_max_clubs: maxClubs,
    });
    if (error) {
      reportError(error, 'SettlementService.runPendingRakebackSettlement');
      throw new Error(`Rakeback settlement failed: ${error.message}`);
    }
    if (!data?.success) {
      throw new Error(`Rakeback settlement failed: ${data?.error || 'unknown error'}`);
    }
    return {
      clubsProcessed: Number(data.clubs_processed || 0),
      periodsSettled: Number(data.periods_settled || 0),
      totalPayout: Number(data.total_payout || 0),
      clubsRemaining: Number(data.clubs_remaining || 0),
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // UNION RAKE BACK — Weekly 90% Distribution
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute weekly union settlement: distribute 90% of collected rake back to clubs.
   * Union keeps 10% and holds ALL BBJ and Promotional chips.
   *
   * FLOW:
   * 1. Query all rake_records for this period, grouped by club
   * 2. For each club in a union: compute 90% rake back
   * 3. Credit 90% to club owner's wallet from union owner's wallet
   * 4. Log all transactions with full audit trail
   */
  async executeUnionRakeBack(
    unionId: string,
    periodStart: string,
    periodEnd: string
  ): Promise<{
    clubsPaid: number;
    totalRakeBack: number;
    unionRetained: number;
  }> {
    // Server-authoritative: fn_execute_union_rakeback (SECURITY DEFINER) does the
    // rake read, per-club rakeback math (union keeps revenueSharePercent, pays back
    // the rest), the union-owner balance check, idempotency (union_rakeback_log is
    // unique per union+period), and every wallet transfer ALL in ONE atomic txn.
    // So: no partial payouts, no double-pay, and no dependence on the caller's RLS
    // to read other clubs' rake/wallets. Only the union owner is authorised
    // (checked server-side via auth.uid()).
    const { data, error } = await supabase.rpc('fn_execute_union_rakeback', {
      p_union_id: unionId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    });

    if (error) {
      reportError(error, 'SettlementService.executeUnionRakeBack', { unionId });
      throw new Error(`Union rakeback failed: ${error.message}`);
    }

    const res = (data || {}) as {
      success?: boolean;
      error?: string;
      clubs_paid?: number;
      total_rakeback?: number;
      union_retained?: number;
      required?: number;
      balance?: number;
    };

    if (!res.success) {
      // Benign idempotent re-run — already paid for this period.
      if (res.error === 'already_executed') {
        return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };
      }
      if (res.error === 'insufficient_balance') {
        try {
          const { FinancialAlertService } = await import('./FinancialAlertService');
          await FinancialAlertService.logCritical(
            'SettlementService.executeUnionRakeBack',
            'Union owner insufficient balance for rakeback distribution',
            { unionId, required: res.required, balance: res.balance, periodStart, periodEnd }
          );
        } catch (e) {
          reportError(e, 'SettlementService');
        }
        masterBus.emit('SETTLEMENT_PAYOUT_FAILED', {
          type: 'union_rakeback_insufficient_balance',
          unionId,
          error: `Union owner balance insufficient. Balance: ${res.balance}, Required: ${res.required}`,
          amount: Number(res.required || 0),
        });
        return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };
      }
      // The close is now funded from the union TREASURY (union_wallets), not
      // the owner's personal wallet, so it can report a treasury shortfall.
      if (res.error === 'insufficient_treasury') {
        try {
          const { FinancialAlertService } = await import('./FinancialAlertService');
          await FinancialAlertService.logCritical(
            'SettlementService.executeUnionRakeBack',
            'Union rake treasury cannot cover the weekly rakeback payout',
            { unionId, periodStart, periodEnd }
          );
        } catch (e) {
          reportError(e, 'SettlementService');
        }
        throw new Error(
          'Union rakeback failed: the rake treasury cannot cover this payout. ' +
            'It was NOT partially paid - investigate before retrying.'
        );
      }
      // Periods must be whole ISO weeks so a manual run addresses exactly the
      // same window as the automated Monday close (otherwise the idempotency
      // log cannot tell they are the same period, and days can be paid twice).
      if (res.error === 'period_must_be_iso_weeks') {
        throw new Error(
          'Union rakeback failed: the period must be whole ISO weeks ' +
            '(Monday 00:00 UTC to Monday 00:00 UTC).'
        );
      }
      // not_authorized / union_not_found / missing_params / a failed transfer
      // (which rolled the whole txn back — nothing was paid).
      reportError(res.error || 'unknown', 'SettlementService.executeUnionRakeBack.failed', {
        unionId,
      });
      throw new Error(`Union rakeback failed: ${res.error || 'unknown error'}`);
    }

    const clubsPaid = Number(res.clubs_paid || 0);
    const totalRakeBack = Number(res.total_rakeback || 0);

    if (clubsPaid > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'union_rakeback', userId: unionId });
    }

    return { clubsPaid, totalRakeBack, unionRetained: Number(res.union_retained || 0) };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // REPORTING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get club settlement report.
   *
   * SWEEP #3 (2026-07-23): repointed off the phantom `club_settlements` table.
   * The club settlement is now derived from the real `generate_period_settlements`
   * read-model RPC (settlement_periods + rake_history + agent_commissions +
   * settlement_invoices).
   */
  async getClubReport(clubId: string, periodId?: string): Promise<ClubSettlement | null> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const pid = periodId || (await this.getCurrentPeriod()).id;
      const { data, error } = await supabase.rpc('generate_period_settlements', {
        p_period_id: pid,
      });
      if (error || !data) return null;
      const clubSettlements: ClubSettlement[] = data.clubSettlements || [];
      return clubSettlements.find((c) => c.clubId === resolvedClubId) || null;
    } catch (err) {
      reportError(err, 'SettlementService.getClubReport', { clubId, periodId });
      return null;
    }
  },

  /**
   * Get agent settlement report.
   *
   * SWEEP #3 (2026-07-23): repointed off the phantom `agent_settlements` table
   * onto the real `calculate_agent_settlement` RPC (agents + agent_commissions).
   */
  async getAgentReport(agentId: string, periodId?: string): Promise<AgentSettlement | null> {
    try {
      const pid = periodId || (await this.getCurrentPeriod()).id;
      const { data, error } = await supabase.rpc('calculate_agent_settlement', {
        p_period_id: pid,
        p_agent_id: agentId,
      });
      if (error || !data) return null;
      return data as AgentSettlement;
    } catch (err) {
      reportError(err, 'SettlementService.getAgentReport', { agentId, periodId });
      return null;
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  mapPeriod(p: any): SettlementPeriod {
    return {
      id: p.id,
      periodNumber: p.period_number,
      year: p.year,
      startAt: p.start_at,
      endAt: p.end_at,
      status: p.status,
      totalRakeCollected: p.total_rake_collected || 0,
      totalBBJContributions: p.total_bbj_contributions || 0,
      totalPlayerWinnings: p.total_player_winnings || 0,
      totalPlayerLosses: p.total_player_losses || 0,
      totalHandsDealt: p.total_hands_dealt || 0,
      settledAt: p.settled_at,
      settledBy: p.settled_by,
    };
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
