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
import { uuid } from '../utils/uuid';
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
    // Validate cap
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

    // P2-17/20: Read old rate for audit trail before updating
    let oldRate = 0;
    const resolvedClubId = await resolveClubUUID(clubId);
    try {
      const { data: existing } = await supabase
        .from('agents')
        .select('commission_rate, player_rakeback_rate')
        .eq('id', agentId)
        .maybeSingle();
      oldRate =
        (targetRole === 'AGENT' ? existing?.commission_rate : existing?.player_rakeback_rate) ?? 0;
    } catch (err) {
      reportError(err, 'CommissionService.setRate.readOldRate', { clubId, agentId, targetRole });
      /* first time set — oldRate stays 0 */
    }

    const { data: result, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_commission_rate: targetRole === 'AGENT' ? rate : null,
      p_player_rakeback_rate: targetRole === 'PLAYER' ? rate : null,
      p_assigned_by: setBy,
    });

    if (error) throw error;
    if (result && result.success === false) {
      throw new Error(result.error || 'Commission rate update rejected');
    }

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
        reportError(err, 'CommissionService.setRate.logRateChange', { agentId, oldRate, rate });
        /* non-blocking */
      }
    }
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
   * CLAIM THIS AGENT'S OWN COMMISSION.
   *
   * Replaces executePayout, which called execute_commission_payout - a function
   * that credited a wallet, debited nothing, and never marked the commission
   * settled, so the same row could be paid again forever. It is dropped
   * (migration 20260902000001) and so is this method's old body.
   *
   * Dan, 2026-08-31: "AGENTS HANDLE THEIR OWN PAYOUTS." The RPC pays auth.uid()
   * and takes no payee parameter, so there is nothing to pass but the club.
   *
   * WHY THIS LOOPS. The claim settles a bounded batch per call, because the
   * largest agent has 192,135 unsettled rows and settling them in one statement
   * measured 64.6 SECONDS against an 8 second statement timeout - and would hold
   * the club row locked for that whole minute, freezing every other chip
   * movement in the club. Each call is its own transaction and its own money
   * conservation, so stopping half way leaves a correct, smaller balance owing.
   *
   * A FRESH op_id PER BATCH, and the same one on a retry. op_id identifies one
   * batch: reusing it after a network wobble replays that batch's answer instead
   * of paying twice, and using a new one for the next batch is what lets the
   * loop make progress.
   */
  async claimCommission(
    clubId: string,
    onProgress?: (claimedSoFar: number, batches: number) => void
  ): Promise<{ claimed: number; batches: number; stoppedEarly: boolean; reason?: string }> {
    const resolvedId = await resolveClubUUID(clubId);
    let claimed = 0;
    let batches = 0;

    // A ceiling, not an expectation. 192,135 rows at 1,000 per batch is 193
    // calls; this stops a runaway loop without stopping a legitimate drain.
    const MAX_BATCHES = 400;

    for (;;) {
      const opId = uuid();
      const { data, error } = await supabase.rpc('fn_agent_claim_commission', {
        p_club_id: resolvedId,
        p_op_id: opId,
      });
      if (error) throw error;

      const result = data as {
        success?: boolean;
        error?: string;
        amount?: number;
        more?: boolean;
        nothing_owed?: boolean;
        bank_short?: boolean;
      } | null;

      if (!result?.success) {
        // Nothing owed on the FIRST call is the honest answer to "claim my
        // commission" when there is none. After a batch has already paid, it
        // means somebody else drained the rest, and what we claimed still counts.
        if (batches > 0) {
          return { claimed, batches, stoppedEarly: true, reason: result?.error };
        }
        throw new Error(result?.error || 'The Claim Was Refused');
      }

      claimed += Number(result.amount ?? 0) || 0;
      batches += 1;
      onProgress?.(claimed, batches);

      if (!result.more) break;
      if (batches >= MAX_BATCHES) {
        return { claimed, batches, stoppedEarly: true, reason: 'More Is Still Owed' };
      }
    }

    masterBus.emit('COMMISSION_PAID', { agentId: 'self', amount: claimed });
    masterBus.emit('CLUB_UPDATED', { clubId: resolvedId });
    return { claimed, batches, stoppedEarly: false };
  },

  /**
   * What this member has earned and not yet claimed, read from the ledger.
   *
   * NOT agents.pending_commission. That column is written by no function and no
   * trigger anywhere in the database; on 2026-08-31 it claimed 26,859.87 owed
   * across 5 agents while agent_commissions held 394,904.61 across 96.
   */
  async unsettledCommission(clubId: string, userId: string): Promise<number> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_agent_unsettled_commission', {
      p_club_id: resolvedId,
      p_user_id: userId,
    });
    if (error) throw error;
    return Number(data ?? 0) || 0;
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
