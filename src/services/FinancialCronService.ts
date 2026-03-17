/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL CRON SERVICE — Automated Financial Health Checks
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs on configurable intervals to enforce financial integrity:
 * - P2-11: Ledger reconciliation (ChipFlowService.runReconciliation)
 * - P2-12: Credit invoice auto-suspension for overdue agents
 * - P2-17: Commission rate change audit trail logging
 *
 * Start via: FinancialCronService.start() in app initialization.
 * Stop via:  FinancialCronService.stop()
 */

import { supabase } from '../lib/supabase';
import { ChipFlowService } from './ChipFlowService';
import { CreditService } from './CreditService';
import { FinancialAlertService } from './FinancialAlertService';
import { masterBus } from '../core/MasterBus';
import { rakebackEngine } from '../engine/RakebackEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FinancialCronConfig {
  /** Reconciliation check interval in ms (default: 24 hours) */
  reconciliationIntervalMs?: number;
  /** Credit suspension check interval in ms (default: 6 hours) */
  suspensionCheckIntervalMs?: number;
  /** Enable automated suspension (default: false — log-only) */
  autoSuspendEnabled?: boolean;
}

export interface ReconciliationResult {
  isBalanced: boolean;
  difference: number;
  checkedAt: string;
}

export interface SuspensionCheckResult {
  agentsChecked: number;
  agentsSuspended: number;
  agentsWarned: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const FinancialCronService = {
  _reconciliationTimer: null as ReturnType<typeof setInterval> | null,
  _suspensionTimer: null as ReturnType<typeof setInterval> | null,
  _disputeEscalationTimer: null as ReturnType<typeof setInterval> | null,
  _rakebackSettlementTimer: null as ReturnType<typeof setInterval> | null,
  _startupTimer: null as ReturnType<typeof setTimeout> | null,
  _isRunning: false,
  _lastReconciliation: null as ReconciliationResult | null,
  _lastSuspensionCheck: null as SuspensionCheckResult | null,
  _config: {
    reconciliationIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
    suspensionCheckIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
    autoSuspendEnabled: false,
  } as Required<FinancialCronConfig>,

  /**
   * Start all financial cron jobs
   */
  start(config: FinancialCronConfig = {}): void {
    if (this._isRunning) this.stop();

    this._config = {
      reconciliationIntervalMs: config.reconciliationIntervalMs ?? 24 * 60 * 60 * 1000,
      suspensionCheckIntervalMs: config.suspensionCheckIntervalMs ?? 6 * 60 * 60 * 1000,
      autoSuspendEnabled: config.autoSuspendEnabled ?? false,
    };

    console.debug(
      '[FinancialCron] Started — reconciliation every',
      this._config.reconciliationIntervalMs / 3600000,
      'h, suspension check every',
      this._config.suspensionCheckIntervalMs / 3600000,
      'h'
    );

    // Delay first run by 30s — avoids noisy failures during app startup
    // when database connections may not be fully established
    this._startupTimer = setTimeout(() => {
      this.runReconciliation();
      this.runSuspensionCheck();
      this.escalateStaleDisputes();
    }, 30_000);

    this._reconciliationTimer = setInterval(
      () => this.runReconciliation(),
      this._config.reconciliationIntervalMs
    );
    this._suspensionTimer = setInterval(
      () => this.runSuspensionCheck(),
      this._config.suspensionCheckIntervalMs
    );
    // Run dispute escalation every 6 hours (same cadence as suspension checks)
    this._disputeEscalationTimer = setInterval(
      () => this.escalateStaleDisputes(),
      this._config.suspensionCheckIntervalMs
    );

    // Settle rakeback weekly (every 7 days) — persists in-memory rakeback to rakeback_periods table
    this._rakebackSettlementTimer = setInterval(
      () => this.settleAllClubRakebacks(),
      7 * 24 * 60 * 60 * 1000 // 7 days
    );

    this._isRunning = true;
  },

  /**
   * Stop all cron jobs
   */
  stop(): void {
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._reconciliationTimer) clearInterval(this._reconciliationTimer);
    if (this._suspensionTimer) clearInterval(this._suspensionTimer);
    if (this._disputeEscalationTimer) clearInterval(this._disputeEscalationTimer);
    if (this._rakebackSettlementTimer) clearInterval(this._rakebackSettlementTimer);
    this._startupTimer = null;
    this._reconciliationTimer = null;
    this._suspensionTimer = null;
    this._disputeEscalationTimer = null;
    this._rakebackSettlementTimer = null;
    this._isRunning = false;
    console.debug('[FinancialCron] Stopped');
  },

  /**
   * Get status for admin dashboard
   */
  getStatus() {
    return {
      isRunning: this._isRunning,
      lastReconciliation: this._lastReconciliation,
      lastSuspensionCheck: this._lastSuspensionCheck,
      config: this._config,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P2-11: AUTOMATED LEDGER RECONCILIATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run full ledger reconciliation.
   * Delegates to ChipFlowService.runReconciliation() which verifies
   * total minted === total in wallets + locked.
   */
  async runReconciliation(): Promise<ReconciliationResult> {
    try {
      const result = await ChipFlowService.runReconciliation();
      const reconciliationResult: ReconciliationResult = {
        isBalanced: result.isBalanced,
        difference: result.difference,
        checkedAt: new Date().toISOString(),
      };
      this._lastReconciliation = reconciliationResult;

      // Persist result to financial_health_checks table for historical tracking
      try {
        await supabase.from('financial_health_checks').insert({
          check_type: 'ledger_reconciliation',
          passed: result.isBalanced,
          details: { difference: result.difference },
          created_at: reconciliationResult.checkedAt,
        });
      } catch (err) {
        console.error('[FinancialCron] Reconciliation audit log failed:', err);
      }

      return reconciliationResult;
    } catch (err: unknown) {
      console.error('[FinancialCron] Reconciliation failed:', err);
      return { isBalanced: false, difference: -1, checkedAt: new Date().toISOString() };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P2-12: CREDIT INVOICE AUTO-SUSPENSION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check all agents with credit lines for overdue invoices.
   * If autoSuspendEnabled, automatically suspend agents with overdue debt.
   * Otherwise, just log warnings for ops review.
   */
  async runSuspensionCheck(): Promise<SuspensionCheckResult> {
    let agentsChecked = 0;
    let agentsSuspended = 0;
    let agentsWarned = 0;

    try {
      // Get all agents with credit lines (not prepaid)
      const { data: agents, error } = await supabase
        .from('agents')
        .select('id, user_id, credit_limit, status')
        .eq('is_prepaid', false)
        .gt('credit_limit', 0);

      if (error || !agents) {
        console.error('[FinancialCron] Failed to fetch credit agents:', error);
        return { agentsChecked: 0, agentsSuspended: 0, agentsWarned: 0 };
      }

      for (const agent of agents) {
        agentsChecked++;

        // Skip already suspended agents
        if (agent.status === 'suspended') continue;

        try {
          const result = await CreditService.checkSuspension(agent.id);

          if (result.shouldSuspend) {
            if (this._config.autoSuspendEnabled) {
              await CreditService.suspendAgent(agent.id, result.reason || 'Overdue invoices');
              agentsSuspended++;

              await FinancialAlertService.logWarning(
                'FinancialCronService',
                `Agent ${agent.id.substring(0, 8)} auto-suspended: ${result.reason}`,
                { agentId: agent.id, reason: result.reason }
              );
            } else {
              agentsWarned++;
              await FinancialAlertService.logWarning(
                'FinancialCronService',
                `Agent ${agent.id.substring(0, 8)} should be suspended (auto-suspend disabled): ${result.reason}`,
                { agentId: agent.id, reason: result.reason }
              );
            }
          }
        } catch (e: unknown) {
          console.error(`[FinancialCron] Suspension check failed for agent ${agent.id}:`, e);
        }
      }

      const result: SuspensionCheckResult = { agentsChecked, agentsSuspended, agentsWarned };
      this._lastSuspensionCheck = result;
      return result;
    } catch (err: unknown) {
      console.error('[FinancialCron] Suspension check failed:', err);
      return { agentsChecked, agentsSuspended, agentsWarned };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P2-17: COMMISSION RATE CHANGE AUDIT TRAIL
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Log a commission rate change for audit purposes.
   * Called from CommissionService.setRate() to record the old and new rates.
   */
  async logRateChange(params: {
    agentId: string;
    changedBy: string;
    oldRate: number;
    newRate: number;
    rateType: 'commission' | 'sub_agent' | 'player';
    clubId?: string;
  }): Promise<void> {
    try {
      await supabase.from('commission_rate_audit').insert({
        agent_id: params.agentId,
        changed_by: params.changedBy,
        old_rate: params.oldRate,
        new_rate: params.newRate,
        rate_type: params.rateType,
        club_id: params.clubId,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[FinancialCron] Audit insert failed:', err);
      console.error('[FinancialCron] commission_rate_audit insert failed (table may not exist)');
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // WEEKLY RAKEBACK SETTLEMENT — Persist in-memory rakeback to DB
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Settle rakeback for ALL active clubs. Queries the clubs table for active clubs,
   * then calls rakebackEngine.settleRakeback() for each, which persists accumulated
   * rakeback to the `rakeback_periods` table for player claiming via RakebackPage.
   */
  async settleAllClubRakebacks(): Promise<{ clubsSettled: number; totalDistributed: number }> {
    let clubsSettled = 0;
    let totalDistributed = 0;

    try {
      const { data: clubs } = await supabase
        .from('clubs')
        .select('id')
        .eq('status', 'active')
        .limit(500);

      if (!clubs || clubs.length === 0) return { clubsSettled, totalDistributed };

      for (const club of clubs) {
        try {
          const distribution = await rakebackEngine.settleRakeback(club.id);
          if (distribution.size > 0) {
            clubsSettled++;
            for (const amount of distribution.values()) {
              totalDistributed += amount;
            }
          }
        } catch (err) {
          console.error(`[FinancialCron] Rakeback settlement failed for club ${club.id}:`, err);
        }
      }

      if (clubsSettled > 0) {
        console.debug(
          `[FinancialCron] Rakeback settled for ${clubsSettled} clubs, total distributed: $${totalDistributed.toFixed(2)}`
        );
      }
    } catch (err) {
      console.error('[FinancialCron] settleAllClubRakebacks failed:', err);
    }

    return { clubsSettled, totalDistributed };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P7-8: DISPUTE AUTO-ESCALATION (72-hour SLA)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Auto-escalate disputes that have been open for more than 72 hours.
   * Runs on the same interval as suspension checks (every 6 hours).
   */
  async escalateStaleDisputes(): Promise<number> {
    let escalated = 0;
    try {
      const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

      const { data: staleDisputes } = await supabase
        .from('disputes')
        .select('id, submitted_by, club_id, reason')
        .eq('status', 'open')
        .lt('created_at', cutoff)
        .limit(50);

      if (!staleDisputes || staleDisputes.length === 0) return 0;

      for (const dispute of staleDisputes) {
        try {
          await supabase
            .from('disputes')
            .update({
              status: 'escalated',
              resolution: 'Auto-escalated: unresolved for 72+ hours',
              updated_at: new Date().toISOString(),
            })
            .eq('id', dispute.id)
            .eq('status', 'open'); // CAS guard

          escalated++;

          await FinancialAlertService.logWarning(
            'FinancialCronService',
            `Dispute ${dispute.id.substring(0, 8)} auto-escalated (72h SLA breach)`,
            { disputeId: dispute.id, clubId: dispute.club_id }
          );
        } catch (e: unknown) {
          console.error(`[FinancialCron] Dispute escalation failed for ${dispute.id}:`, e);
        }
      }

      if (escalated > 0) {
        masterBus.emit('FINANCIAL_ALERT', {
          severity: 'warning',
          source: 'FinancialCronService',
          message: `${escalated} dispute(s) auto-escalated (72h SLA breach)`,
          context: { escalatedCount: escalated },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: unknown) {
      console.error('[FinancialCron] Dispute escalation check failed:', err);
    }
    return escalated;
  },
};

export default FinancialCronService;
