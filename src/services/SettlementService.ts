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
import { pushNotificationService } from './PushNotificationService';
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
   * Get or create the current settlement period
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
          '[Settlement] get_current_settlement_period returned a row with no id — refusing to fabricate an orphaned period.'
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
      '[Settlement] get_current_settlement_period returned no rows — settlement period unavailable.'
    );
  },

  /**
   * Get historical periods
   */
  async getPeriodHistory(limit: number = 12): Promise<SettlementPeriod[]> {
    const { data, error } = await supabase
      .from('settlement_periods')
      .select(
        'id, period_number, year, start_at, end_at, status, total_rake_collected, total_bbj_contributions, total_player_winnings, total_player_losses, total_hands_dealt, settled_at, settled_by'
      )
      .order('start_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data.map(this.mapPeriod);
  },

  /**
   * Close period and begin processing
   */
  async closePeriod(periodId: string): Promise<boolean> {
    const { error } = await supabase
      .from('settlement_periods')
      .update({ status: 'processing' })
      .eq('id', periodId);

    if (error) throw error;
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
      `[Settlement] executeMondayPayouts is retired (no-op) for period ${periodId} — ` +
        'agent payouts flow through credit_invoices; player rakeback through the engine ' +
        'RakebackSettlerService.'
    );
    return { agentsPaid: 0, playersWithRakeback: 0, totalDisbursed: 0 };
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
    // Get union info
    // RAKE-AUDIT 2026-07-24: settings included — revenueSharePercent (the
    // union's retained cut) was stored in union settings but IGNORED; the 90%
    // rake-back ratio was hardcoded. Now: rakeBack = rake × (1 − share/100),
    // defaulting to the historical 10% share when unconfigured.
    const { data: union } = await supabase
      .from('unions')
      .select('owner_id, name, settings')
      .eq('id', unionId)
      .maybeSingle();

    if (!union?.owner_id) throw new Error('Union not found');

    const revenueSharePercent = (() => {
      const raw = (union as { settings?: { revenueSharePercent?: unknown } | null })?.settings
        ?.revenueSharePercent;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 10;
    })();
    const rakeBackRatio = (100 - revenueSharePercent) / 100;

    // Idempotency: Verify we haven't already paid out this union for this period
    // (This uses verify_and_log_union_rakeback to guarantee exactly-once execution)
    // First, we need to quickly sum the rake to pass to the idempotency checker
    const { data: earlyRakeData } = await supabase.rpc('get_union_rake_for_period', {
      p_union_id: unionId,
      p_start: periodStart,
      p_end: periodEnd,
    });

    // Pre-compute total rakeback from the rake query so the idempotency guard
    // records the real expected amount (prevents permanent lockout on crash).
    const estimatedTotalRake = Array.isArray(earlyRakeData)
      ? earlyRakeData.reduce((sum: number, r: any) => sum + Number(r.rake_amount || 0), 0)
      : Number(earlyRakeData?.total_rake || 0);
    const estimatedRakeBack = Math.trunc(estimatedTotalRake * rakeBackRatio * 100) / 100;

    const { data: canExecute, error: execErr } = await supabase.rpc(
      'verify_and_log_union_rakeback',
      {
        p_union_id: unionId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_total_rakeback: estimatedRakeBack,
      }
    );

    if (execErr) {
      reportError(execErr, 'SettlementService.executeUnionRakeBack.idempotency', { unionId });
      throw new Error(`Execution verification failed: ${execErr.message}`);
    }

    if (canExecute === false) {
      reportError(
        `Union ${unionId} already paid for ${periodStart} - ${periodEnd}`,
        'SettlementService.executeUnionRakeBack.alreadyPaid',
        { unionId }
      );
      return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };
    }

    // Get all clubs in this union
    const { data: clubs } = await supabase
      .from('clubs')
      .select('id, name, owner_id')
      .eq('union_id', unionId);

    if (!clubs || clubs.length === 0) return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };

    // PRE-CHECK: Verify union owner has sufficient balance for total rakeback
    // This prevents partial payouts where some clubs get paid and others don't
    const { data: unionOwnerWallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', union.owner_id)
      .maybeSingle();

    const unionOwnerBalance = Number(unionOwnerWallet?.balance || 0);

    // Calculate total estimated payout to all clubs
    let totalEstimatedRakeBack = 0;
    const clubRakeMap = new Map<string, number>();

    for (const club of clubs) {
      // RAKE-AUDIT 2026-07-24: read the LIVE per-hand rake ledger rake_records
      // (created_at). The previous source, rake_history, stopped receiving
      // writes on 2026-05-01 (Phase J removed the insert), so every club's
      // rake summed to 0 and the union 90% rake-back silently paid clubs
      // NOTHING while reporting success.
      const { data: rakeData } = await supabase
        .from('rake_records')
        .select('rake_amount')
        .eq('club_id', club.id)
        .gte('created_at', periodStart)
        .lt('created_at', periodEnd);

      const clubRake = (rakeData || []).reduce((sum, r) => sum + Number(r.rake_amount), 0);
      const rakeBack = Math.trunc(clubRake * rakeBackRatio * 100) / 100;
      clubRakeMap.set(club.id, rakeBack);
      totalEstimatedRakeBack += rakeBack;
    }

    // CRITICAL ALERT: Insufficient balance — abort all payouts
    if (unionOwnerBalance < totalEstimatedRakeBack) {
      const shortfall = totalEstimatedRakeBack - unionOwnerBalance;
      reportError(
        `Union owner insufficient balance: Balance=${unionOwnerBalance}, Required=${totalEstimatedRakeBack}, Shortfall=${shortfall}`,
        'SettlementService.executeUnionRakeBack.insufficientBalance',
        { unionId, unionOwnerBalance, totalEstimatedRakeBack, shortfall }
      );

      try {
        const { FinancialAlertService } = await import('./FinancialAlertService');
        await FinancialAlertService.logCritical(
          'SettlementService.executeUnionRakeBack',
          `Union owner insufficient balance for rakeback distribution`,
          {
            unionId,
            unionOwnerId: union.owner_id,
            unionOwnerBalance,
            totalEstimatedRakeBack,
            shortfall,
            periodStart,
            periodEnd,
            affectedClubs: clubs.length,
          }
        );
      } catch (e) {
        reportError(e, 'SettlementService');
        /* best effort */
      }

      masterBus.emit('SETTLEMENT_PAYOUT_FAILED', {
        type: 'union_rakeback_insufficient_balance',
        unionId,
        error: `Union owner balance insufficient. Balance: ${unionOwnerBalance}, Required: ${totalEstimatedRakeBack}, Shortfall: ${shortfall}`,
        amount: totalEstimatedRakeBack,
      });

      return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };
    }

    let clubsPaid = 0;
    let totalRakeBack = 0;
    let totalCollected = 0;

    for (const club of clubs) {
      const rakeBack = clubRakeMap.get(club.id) || 0;
      if (rakeBack <= 0) continue;

      // Estimate original rake from rakeback (reverse: rakeBack = rake * ratio)
      // RAKE-AUDIT 2026-07-24: uses the union's configured ratio, not fixed 90%.
      const rakeBackCents = Math.trunc(rakeBack * 100);
      const clubRake =
        rakeBackRatio > 0 ? Math.trunc(rakeBackCents / rakeBackRatio) / 100 : rakeBack;
      totalCollected += clubRake;

      if (rakeBack > 0 && club.owner_id) {
        // Atomic Settlement Transfer
        const { data: transferResult, error: transferError } = await retryAsync(
          () =>
            supabase.rpc('atomic_wallet_transfer', {
              p_from_user_id: union.owner_id,
              p_to_user_id: club.owner_id,
              p_amount: rakeBack,
              p_category: 'settlement',
              p_debit_description: `Weekly rake back to ${club.name}: 90% of ${clubRake}`,
              p_credit_description: `Weekly rake back from ${union.name}: 90% of ${clubRake} collected`,
              p_related_entity_id: club.id,
            }),
          3
        );

        if (transferError || transferResult === false) {
          const errMsg =
            transferError?.message || 'transferResult === false (insufficient balance?)';
          reportError(
            transferError || 'transferResult === false',
            'SettlementService.executeUnionRakeBack.transfer',
            { unionId, clubId: club.id, clubName: club.name, rakeBack }
          );

          // Log critical financial alert — silent skipping is dangerous for money movement
          try {
            const { FinancialAlertService } = await import('./FinancialAlertService');
            await FinancialAlertService.logCritical(
              'SettlementService.executeUnionRakeBack',
              `Union rakeback transfer FAILED for club ${club.name} — ${rakeBack} chips not delivered. Manual reconciliation required.`,
              {
                unionId,
                clubId: club.id,
                clubName: club.name,
                clubOwnerId: club.owner_id,
                unionOwnerId: union.owner_id,
                rakeBack,
                clubRake: clubRake,
                periodStart,
                periodEnd,
                error: errMsg,
              }
            );
          } catch (e) {
            reportError(e, 'SettlementService');
            /* best effort — already logged to console */
          }

          // Emit bus event so admin dashboards see the failure
          masterBus.emit('SETTLEMENT_PAYOUT_FAILED', {
            type: 'union_rakeback',
            unionId,
            clubId: club.id,
            clubName: club.name,
            amount: rakeBack,
            error: errMsg,
          });

          continue;
        }

        // Emit bus event so UI updates immediately
        masterBus.emit('BALANCE_UPDATED', {
          source: 'union_rakeback_deduct',
          userId: union.owner_id,
        });
        masterBus.emit('BALANCE_UPDATED', {
          source: 'union_rakeback_credit',
          userId: club.owner_id,
        });

        clubsPaid++;
        totalRakeBack += rakeBack;
      }
    }

    const unionRetained = Math.trunc((totalCollected - totalRakeBack) * 100) / 100;

    return { clubsPaid, totalRakeBack, unionRetained };
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
