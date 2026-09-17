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
import { resolveClubUUID, resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';

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
   * Set commission rate with cap validation.
   *
   * SWEEP #3 (2026-07-23): repointed off the phantom `commission_structures`
   * table. Rates live on the real `agents` row (commission_rate /
   * player_rakeback_rate) and MUST be written through the SECURITY DEFINER
   * `fn_admin_update_agent` RPC — direct `agents` writes are RLS-locked and
   * fail silently. Sub-agent rates live in `sub_agents.commission_pct` and are
   * managed server-side (no client write policy).
   */
  async setRate(
    clubId: string,
    agentId: string,
    targetRole: CommissionTargetRole,
    rate: number,
    setBy: string
  ): Promise<CommissionRate> {
    // Validate cap before resolving or mutating the selected club.
    if (!Number.isFinite(rate)) throw new Error('Rate Must Be A Finite Number');
    const cap = RATE_CAPS[targetRole];
    if (rate > cap) {
      throw new Error(`${targetRole} rate capped at ${cap * 100}%. Requested: ${rate * 100}%`);
    }
    if (rate < 0) {
      throw new Error('Rate cannot be negative');
    }
    if (targetRole === 'SUB_AGENT') {
      throw new Error(
        'Sub-agent rates are managed server-side (sub_agents.commission_pct) - no client write path.'
      );
    }

    const resolvedClubId = await resolveClubUUIDStrict(clubId);
    const { data: existing, error: existingError } = await supabase
      .from('agents')
      .select('id, club_id')
      .eq('id', agentId)
      .eq('club_id', resolvedClubId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.id !== agentId || existing.club_id !== resolvedClubId) {
      throw new Error('Agent Could Not Be Confirmed In The Selected Club');
    }

    const { data: result, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_commission_rate: targetRole === 'AGENT' ? rate : null,
      p_player_rakeback_rate: targetRole === 'PLAYER' ? rate : null,
      p_assigned_by: setBy,
    });

    if (error) throw error;
    if (result?.success !== true) {
      throw new Error(result?.error || 'Commission rate update rejected');
    }
    if (result.agent_id !== agentId || result.club_id !== resolvedClubId) {
      throw new Error('Commission Rate Update Could Not Be Confirmed For The Selected Club');
    }
    // accounting_agreement_history is written atomically by the database.
    // A second browser audit write cannot establish or repair that evidence.
    return {
      id: agentId,
      clubId: resolvedClubId,
      agentId,
      targetRole,
      rate,
      effectiveDate: new Date().toISOString(),
      createdBy: setBy,
    };
  },

  /**
   * Get all rates for an agent.
   *
   * SWEEP #3 (2026-07-23): repointed off the phantom `commission_structures`
   * table onto the real stores: agents.commission_rate (AGENT),
   * agents.player_rakeback_rate (PLAYER), sub_agents.commission_pct (SUB_AGENT,
   * one entry per sub-agent).
   */
  async getRates(agentId: string): Promise<CommissionRate[]> {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('id, club_id, commission_rate, player_rakeback_rate, updated_at')
      .eq('id', agentId)
      .maybeSingle();

    if (error) throw error;

    const rates: CommissionRate[] = [];
    if (agent) {
      rates.push(
        {
          id: `${agent.id}:AGENT`,
          clubId: agent.club_id,
          agentId: agent.id,
          targetRole: 'AGENT',
          rate: agent.commission_rate ?? 0,
          effectiveDate: agent.updated_at,
          createdBy: '',
        },
        {
          id: `${agent.id}:PLAYER`,
          clubId: agent.club_id,
          agentId: agent.id,
          targetRole: 'PLAYER',
          rate: agent.player_rakeback_rate ?? 0,
          effectiveDate: agent.updated_at,
          createdBy: '',
        }
      );
    }

    const { data: subs } = await supabase
      .from('sub_agents')
      .select('id, club_id, commission_pct, updated_at')
      .eq('parent_agent_id', agentId);

    (subs || []).forEach((s) =>
      rates.push({
        id: s.id,
        clubId: s.club_id,
        agentId,
        targetRole: 'SUB_AGENT',
        rate: s.commission_pct ?? 0,
        effectiveDate: s.updated_at,
        createdBy: '',
      })
    );

    return rates;
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
  // RAKE ATTRIBUTION — CLIENT PATH DELETED (Dan 2026-08-29, weighted rake law)
  //
  // attributeRake() and getPlayerRakeTotal() were removed in the weighted
  // contributed rake residue sweep. Both were dead (zero callers) and both
  // belonged to the retired client-side attribution era: rake_attributions is
  // now the ENGINE's per-player weighted ledger, written exclusively inside
  // atomic_distribute_rake (RLS: service_role writes, players read only their
  // own rows), and per-player rake totals come from the authoritative pipeline
  // (rakeback_periods / player_stats / fn_agent_downline_rake). The frontend
  // must never write or recompute financial attribution (§30, server
  // authoritative).
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
    // RPC returns snake_case table rows over agents + agent_commissions
    return (data || []).map((p: any) => ({
      agentId: p.agent_id,
      periodId: p.period_id,
      grossRake: p.gross_rake || 0,
      commissionEarned: p.commission_earned || 0,
      paidToDownlines: p.paid_to_downlines || 0,
      netPayout: p.net_payout || 0,
      status: p.status || 'pending',
    }));
  },

  /**
   * Approve commission payout.
   *
   * RETIRED (sweep #3, 2026-07-23). The `commission_payouts` approval table was
   * removed from the schema and no UI calls this method. Commission amounts are
   * accrued per-hand into `agent_commissions` by the engine RakebackSettler and
   * settled through the credit_invoices subsystem — there is no client-side
   * approval step. Kept as a no-op so any stale caller resolves cleanly.
   */
  async approvePayout(payoutId: string, approvedBy: string): Promise<boolean> {
    console.debug(
      `[Commission] approvePayout is retired (no-op) for ${payoutId} by ${approvedBy} - ` +
        'commissions accrue in agent_commissions and settle via credit_invoices.'
    );
    return false;
  },

  /**
   * What this member has earned and not yet claimed, read from the ledger.
   *
   * NOT agents.pending_commission. That column is written by no function and no
   * trigger anywhere in the database; on 2026-08-31 it claimed 26,859.87 owed
   * across 5 agents while agent_commissions held 394,904.61 across 96.
   */
  async unsettledCommission(clubId: string, userId: string): Promise<number> {
    const resolvedId = await resolveClubUUIDStrict(clubId);
    const { data, error } = await supabase.rpc('fn_agent_unsettled_commission', {
      p_club_id: resolvedId,
      p_user_id: userId,
    });
    if (error) throw error;
    if (
      (typeof data !== 'number' && typeof data !== 'string') ||
      String(data).trim() === '' ||
      !Number.isFinite(Number(data))
    ) {
      throw new Error('Unpaid Commission Is Unavailable');
    }
    return Number(data);
  },

  /**
   * What each of this agent's downlines is still owed, from the ledger.
   *
   * PHASE 7. The Sub-Agents tab printed `agents.pending_commission` for each
   * downline - the column nothing wrote - so every figure in that column was a
   * frozen number or a zero. It cannot simply select from agent_commissions
   * instead: RLS lets an agent read their OWN commission rows and nobody
   * else's, which is correct, so an upline needs a definer function.
   *
   * It answers UNCLAIMED rather than lifetime: it is what the club still owes,
   * and it is the figure the partial index can produce without reading every
   * row every downline has ever generated.
   */
  async downlineCommission(
    clubId?: string
  ): Promise<{ agentId: string; userId: string; unclaimed: number }[]> {
    const resolvedId = clubId ? await resolveClubUUIDStrict(clubId) : null;
    const { data, error } = await supabase.rpc('fn_agent_downline_commission', {
      p_club_id: resolvedId,
    });
    if (error) throw error;
    if (
      !Array.isArray(data) ||
      data.some(
        (row: any) =>
          !row ||
          typeof row.agent_id !== 'string' ||
          !row.agent_id ||
          typeof row.user_id !== 'string' ||
          !row.user_id ||
          (resolvedId !== null && row.club_id !== resolvedId) ||
          (typeof row.unclaimed !== 'number' && typeof row.unclaimed !== 'string') ||
          String(row.unclaimed).trim() === '' ||
          !Number.isFinite(Number(row.unclaimed))
      )
    ) {
      throw new Error('Sub-Agent Commission Is Unavailable');
    }
    if (new Set(data.map((row: any) => row.agent_id)).size !== data.length) {
      throw new Error('Sub-Agent Commission Is Unavailable');
    }
    return data.map((row: any) => ({
      agentId: row.agent_id,
      userId: row.user_id,
      unclaimed: Number(row.unclaimed),
    }));
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // REPORTING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get agent's commission history.
   *
   * SWEEP #3 (2026-07-23): repointed off the phantom `commission_payouts`
   * table onto `agent_commissions`, the live per-hand commission ledger
   * (keyed by the agent's auth user_id, so the agents.id PK is resolved first).
   */
  async getCommissionHistory(agentId: string, limit: number = 10): Promise<CommissionPayout[]> {
    // agent_commissions is keyed by user_id (auth uid), not agents.id
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('user_id, club_id')
      .eq('id', agentId)
      .maybeSingle();

    if (agentError) throw agentError;
    if (!agent?.user_id) return [];

    const { data, error } = await supabase
      .from('agent_commissions')
      .select('id, club_id, user_id, amount, source_type, created_at')
      .eq('user_id', agent.user_id)
      .eq('club_id', agent.club_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map((p) => ({
      agentId,
      periodId: '',
      grossRake: 0,
      commissionEarned: p.amount || 0,
      paidToDownlines: 0,
      netPayout: p.amount || 0,
      status: 'paid' as const,
    }));
  },
};

export default CommissionService;
