/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMISSION SERVICE — Hierarchical Commission System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles cascading commission calculations across the agent hierarchy.
 *
 * HIERARCHY CAPS:
 * - Club → Agent: Max 70%
 * - Agent → Sub-Agent: Max 60%
 * - Agent → Player (Rakeback): Max 50%
 *
 * FLOW:
 * 1. Hand completes → Rake calculated
 * 2. Rake attributed to dealt-in players
 * 3. Commission cascades up the agent tree
 * 4. Rakeback flows down to players
 * 5. Net margins queued for Monday settlement
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CommissionTargetRole = 'AGENT' | 'SUB_AGENT' | 'PLAYER';

export interface CommissionRate {
  id: string;
  clubId: string;
  agentId: string;
  targetRole: CommissionTargetRole;
  rate: number; // 0.00 - 1.00
  effectiveDate: string;
  createdBy: string;
}

export interface CommissionSpread {
  agentId: string;
  grossCommissionRate: number; // Rate I receive from upline
  payoutToDownlines: number; // Sum of what I pay downlines
  netMargin: number; // What I keep
  downlineBreakdown: Array<{
    entityId: string;
    entityType: 'agent' | 'player';
    name: string;
    rate: number;
    rakeGenerated: number;
    commissionPaid: number;
  }>;
}

export interface RakeAttribution {
  handId: string;
  playerId: string;
  rakeAmount: number;
  agentId?: string;
  timestamp: string;
}

export interface CommissionPayout {
  agentId: string;
  periodId: string;
  grossRake: number;
  commissionEarned: number;
  paidToDownlines: number;
  netPayout: number;
  status: 'pending' | 'approved' | 'paid';
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const RATE_CAPS: Record<CommissionTargetRole, number> = {
  AGENT: 0.7,
  SUB_AGENT: 0.6,
  PLAYER: 0.5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const CommissionService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // RATE MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Set commission rate with cap validation
   */
  async setRate(
    clubId: string,
    agentId: string,
    targetRole: CommissionTargetRole,
    rate: number,
    setBy: string
  ): Promise<CommissionRate> {
    // Validate cap
    const cap = RATE_CAPS[targetRole];
    if (rate > cap) {
      throw new Error(`${targetRole} rate capped at ${cap * 100}%. Requested: ${rate * 100}%`);
    }
    if (rate < 0) {
      throw new Error('Rate cannot be negative');
    }

    // P2-17/20: Read old rate for audit trail before upserting
    let oldRate = 0;
    const resolvedClubId = await resolveClubUUID(clubId);
    try {
      const { data: existing } = await supabase
        .from('commission_structures')
        .select('rate')
        .eq('club_id', resolvedClubId)
        .eq('agent_id', agentId)
        .eq('target_role', targetRole)
        .maybeSingle();
      oldRate = existing?.rate ?? 0;
    } catch (err) {

      console.error("[CommissionService] Error:", err);
      /* first time set — oldRate stays 0 */
    }

    const { data, error } = await supabase
      .from('commission_structures')
      .upsert(
        {
          club_id: clubId,
          agent_id: agentId,
          target_role: targetRole,
          rate,
          // commission_structures schema: set_by, updated_at (NOT created_by, effective_date)
          updated_at: new Date().toISOString(),
          set_by: setBy,
        },
        { onConflict: 'club_id,agent_id,target_role' }
      )
      .select()
      .maybeSingle();

    if (error) throw error;

    // P2-17/20: Log the rate change for audit trail (non-blocking)
    if (oldRate !== rate) {
      try {
        const { FinancialCronService } = await import('./FinancialCronService');
        await FinancialCronService.logRateChange({
          agentId,
          changedBy: setBy,
          oldRate,
          newRate: rate,
          rateType: targetRole as 'commission' | 'sub_agent' | 'player',
          clubId,
        });
      } catch (err) {

        console.error("[CommissionService] Error:", err);
        /* non-blocking */
      }
    }
    if (!data) throw new Error('Commission rate upsert returned no data');
    return {
      id: data.id,
      clubId: data.club_id,
      agentId: data.agent_id,
      targetRole: data.target_role,
      rate: data.rate,
      effectiveDate: data.updated_at,
      createdBy: data.set_by,
    };
  },

  /**
   * Get all rates for an agent
   */
  async getRates(agentId: string): Promise<CommissionRate[]> {
    const { data, error } = await supabase
      .from('commission_structures')
      // commission_structures schema: set_by, updated_at (NOT created_by, effective_date)
      .select('id, club_id, agent_id, target_role, rate, updated_at, set_by')
      .eq('agent_id', agentId);

    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id,
      clubId: r.club_id,
      agentId: r.agent_id,
      targetRole: r.target_role,
      rate: r.rate,
      effectiveDate: r.updated_at,
      createdBy: r.set_by,
    }));
  },

  /**
   * Get rate for a specific target
   */
  async getRate(agentId: string, targetRole: CommissionTargetRole): Promise<number> {
    const rates = await this.getRates(agentId);
    const rate = rates.find((r) => r.targetRole === targetRole);
    return rate?.rate ?? 0;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SPREAD CALCULATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate commission spread for an agent
   * Shows gross, payouts, and net margin
   */
  async calculateSpread(agentId: string, periodId?: string): Promise<CommissionSpread> {
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('calculate_agent_spread', {
          p_agent_id: agentId,
          p_period_id: periodId || null,
        }),
      3
    );

    if (error) throw error;
    if (!data) throw new Error('Commission spread calculation failed: no data returned');
    return data;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // RAKE ATTRIBUTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Attribute rake to players after hand completion
   * Called by RakeService after pot drops
   */
  async attributeRake(handId: string, attributions: RakeAttribution[]): Promise<void> {
    const records = attributions.map((a) => ({
      hand_id: handId,
      player_id: a.playerId,
      rake_amount: a.rakeAmount,
      agent_id: a.agentId || null,
      created_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from('rake_attributions').insert(records);

    if (error) throw error;
  },

  /**
   * Get player's total rake contribution
   */
  async getPlayerRakeTotal(playerId: string, periodId?: string): Promise<number> {
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('get_player_rake_total', {
          p_player_id: playerId,
          p_period_id: periodId || null,
        }),
      3
    );

    if (error) throw error;
    return data;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // CASCADING COMMISSION CALCULATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate cascading commissions for a hand
   * Walks up the agent tree, calculating each level's share
   */
  async calculateCascadingCommission(
    rakeAmount: number,
    playerId: string
  ): Promise<Array<{ agentId: string; amount: number; level: number }>> {
    const { data, error } = await retryAsync(async () => {
      const result = await supabase.rpc('calculate_cascading_commission', {
        p_rake_amount: rakeAmount,
        p_player_id: playerId,
      });
      return result;
    }, 2);

    if (error) throw error;
    return data;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SETTLEMENT INTEGRATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Generate commission payouts for a settlement period
   */
  async generatePeriodPayouts(periodId: string): Promise<CommissionPayout[]> {
    const { data, error } = await retryAsync(async () => {
      const result = await supabase.rpc('generate_period_commissions', {
        p_period_id: periodId,
      });
      return result;
    }, 2);

    if (error) throw error;
    return data;
  },

  /**
   * Approve commission payout
   */
  async approvePayout(payoutId: string, approvedBy: string): Promise<boolean> {
    const { error } = await supabase
      .from('commission_payouts')
      .update({
        status: 'approved',
        approved_by: approvedBy,
        approved_at: new Date().toISOString(),
      })
      .eq('id', payoutId);

    if (error) throw error;
    return true;
  },

  /**
   * Execute commission payout (credit to wallet)
   */
  async executePayout(payoutId: string): Promise<boolean> {
    const { error } = await retryAsync(async () => {
      const result = await supabase.rpc('execute_commission_payout', {
        p_payout_id: payoutId,
      });
      return result;
    }, 2);

    if (error) throw error;

    // Fetch the payout record for accurate bus event data
    const { data: payout } = await supabase
      .from('commission_payouts')
      .select('agent_id, net_payout')
      .eq('id', payoutId)
      .maybeSingle();

    // Notify listening pages (ClubFinancialsPage) that a commission was paid
    masterBus.emit('COMMISSION_PAID', {
      agentId: payout?.agent_id || payoutId,
      amount: payout?.net_payout || 0,
    });
    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // REPORTING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get agent's commission history
   */
  async getCommissionHistory(agentId: string, limit: number = 10): Promise<CommissionPayout[]> {
    const { data, error } = await supabase
      .from('commission_payouts')
      .select(
        'id, agent_id, period_id, gross_rake, commission_earned, paid_to_downlines, net_payout, status, created_at'
      )
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map((p) => ({
      agentId: p.agent_id,
      periodId: p.period_id,
      grossRake: p.gross_rake,
      commissionEarned: p.commission_earned,
      paidToDownlines: p.paid_to_downlines,
      netPayout: p.net_payout,
      status: p.status,
    }));
  },
};

export default CommissionService;
