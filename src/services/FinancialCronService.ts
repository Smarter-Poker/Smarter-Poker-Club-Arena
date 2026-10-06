import { getIdentityDNAStatus } from '../core/IdentityDNA';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL HEALTH CHECKS - on demand, from an admin's own console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * NOTHING HERE IS SCHEDULED, AND NOTHING HERE MAY BE (2026-10-05).
 *
 * This file used to be a browser "cron": ServiceBootstrap started it in every
 * tab, and 30 seconds after load and every six hours after that it scanned
 * `agents` for overdue credit. A financial schedule does not belong in a
 * browser. It ran under whoever happened to have a tab open - including signed
 * out visitors, which is where the four "permission denied for table agents"
 * errors of 2026-10-05 22:02-23:02 UTC came from (anon holds no SELECT on
 * agents) - and under RLS a signed-in tab sees only the agents its own cashier
 * scope reaches, so even a "successful" scan was one club's slice reported as
 * the whole book. It also never did anything: autoSuspendEnabled was false, so
 * the most it could produce was a warning.
 *
 * What remains is the admin's "Run Now" on FinancialHealthPage: a deliberate,
 * signed-in, scope-limited read of the agents that admin may see. It refuses
 * without a signed-in identity rather than reading as anon.
 *
 * - Ledger reconciliation is server-side and snapshot-based (AUDIT M4,
 *   fn_snapshot_chip_supply); runReconciliation below only says so.
 * - P2-12: credit invoice suspension check, on demand, log-only by default.
 * - P2-17: commission rate change audit trail logging.
 */

import { supabase } from '../lib/supabase';
import { CreditService } from './CreditService';
import { FinancialAlertService } from './FinancialAlertService';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FinancialCronConfig {
  /** Suspend on a check rather than only warning (default: false, log-only) */
  autoSuspendEnabled?: boolean;
}

export interface ReconciliationResult {
  isBalanced: boolean;
  difference: number;
  checkedAt: string;
  /**
   * AUDIT M4: true when the client cannot answer the question at all, which is
   * now always. Distinguishes "the books do not balance" from "this process is
   * not in a position to know" - conflating those two is what produced 1,039
   * false failures.
   */
  unavailable?: boolean;
}

export interface SuspensionCheckResult {
  checkedAt?: string;
  disabled?: boolean;
  /** Unknown or disabled is not a completed clean scan. */
  unavailable?: boolean;
  agentsChecked: number;
  agentsSuspended: number;
  agentsWarned: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const FinancialCronService = {
  _scopeGeneration: 0,
  _lastReconciliation: null as ReconciliationResult | null,
  _lastSuspensionCheck: null as SuspensionCheckResult | null,
  /** FIX-216: Circuit breaker - stop scanning after persistent failures */
  _suspensionCheckFailed: 0,
  _suspensionCheckDisabled: false,
  _config: {
    autoSuspendEnabled: false,
  } as Required<FinancialCronConfig>,

  /**
   * Get status for admin dashboard
   */
  getStatus() {
    return {
      lastReconciliation: this._lastReconciliation,
      lastSuspensionCheck: this._lastSuspensionCheck,
      config: this._config,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P2-11: AUTOMATED LEDGER RECONCILIATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ledger reconciliation is server-side now — this is a deliberate no-op.
   *
   * AUDIT M4: kept as a method (FinancialHealthPage still calls it from an
   * admin button) but it no longer computes or writes anything. A browser
   * cannot reconcile a chip supply it can only see one row of, and
   * financial_health_checks is service_role-write-only as of the same
   * migration, so an attempt would now fail with 42501 rather than silently
   * recording a per-user number.
   */
  async runReconciliation(): Promise<ReconciliationResult> {
    console.warn(
      '[FinancialCron] Ledger reconciliation is server-side (fn_snapshot_chip_supply); ' +
        'the client-side check was removed in AUDIT M4.'
    );
    return {
      isBalanced: false,
      difference: 0,
      checkedAt: new Date().toISOString(),
      unavailable: true,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P2-12: CREDIT INVOICE AUTO-SUSPENSION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check the agents with credit lines that this signed-in admin may see for
   * overdue invoices. Run only from the admin's own "Run Now"; never on a timer.
   * If autoSuspendEnabled, suspend agents with overdue debt; otherwise warn.
   */
  async runSuspensionCheck(): Promise<SuspensionCheckResult> {
    const generation = this._scopeGeneration;
    const current = () => generation === this._scopeGeneration;
    let unavailable = false;
    const publish = (result: SuspensionCheckResult): SuspensionCheckResult => {
      result = {
        ...result,
        checkedAt: new Date().toISOString(),
        disabled: this._suspensionCheckDisabled,
      };
      if (current()) this._lastSuspensionCheck = result;
      return result;
    };
    const unknown = (): SuspensionCheckResult =>
      publish({
        agentsChecked: 0,
        agentsSuspended: 0,
        agentsWarned: 0,
        unavailable: true,
      });
    if (!cronIdentityReady() || !current()) return unknown();
    // FIX-216: Circuit breaker — skip if disabled after 2+ consecutive global failures
    if (this._suspensionCheckDisabled) {
      return unknown();
    }

    // Invoice generation belongs to the server weekly close. A browser only reads
    // the resulting obligations; it cannot run billing for every club.

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

      if (!current()) return unknown();
      if (error || !Array.isArray(agents)) {
        this._suspensionCheckFailed++;
        if (this._suspensionCheckFailed >= 2) {
          this._suspensionCheckDisabled = true;
          console.debug('[FinancialCron] Suspension check disabled after repeated failures');
        }
        reportError(error, 'FinancialCronService.runSuspensionCheck.fetchAgents');
        return unknown();
      }

      this._suspensionCheckFailed = 0;

      // FIX-216: Track per-agent failures; if ALL fail, disable future runs
      let consecutiveFailures = 0;

      for (const agent of agents) {
        agentsChecked++;

        // Skip already suspended agents
        if (agent.status === 'suspended') continue;

        try {
          const result = await CreditService.checkSuspension(agent.id);
          if (!current()) return unknown();

          if (result.shouldSuspend) {
            if (this._config.autoSuspendEnabled) {
              await CreditService.suspendAgent(agent.id, result.reason || 'Overdue invoices');
              if (!current()) return unknown();
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
          if (!current()) return unknown();
          consecutiveFailures = 0; // The whole agent attempt succeeded.
        } catch (e: unknown) {
          if (!current()) return unknown();
          unavailable = true;
          consecutiveFailures++;
          // FIX-216: If first 3 agents all fail, the infrastructure is broken — stop spamming
          if (consecutiveFailures >= 3) {
            this._suspensionCheckDisabled = true;
            console.debug(
              '[FinancialCron] Suspension check disabled - CreditService.checkSuspension unavailable'
            );
            break;
          }
          reportError(e, 'FinancialCronService.runSuspensionCheck.agent', {
            agentId: agent.id,
          });
        }
      }

      const result: SuspensionCheckResult = {
        agentsChecked,
        agentsSuspended,
        agentsWarned,
        ...(unavailable ? { unavailable: true } : {}),
      };
      return publish(result);
    } catch (err: unknown) {
      if (!current()) return unknown();
      this._suspensionCheckFailed++;
      if (this._suspensionCheckFailed >= 2) this._suspensionCheckDisabled = true;
      reportError(err, 'FinancialCronService.runSuspensionCheck');
      return publish({
        agentsChecked,
        agentsSuspended,
        agentsWarned,
        unavailable: true,
      });
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
      reportError(err, 'FinancialCronService.logRateChange');
    }
  },

  /** Retired compatibility entry point. Never report zero as a paid result. */
  async settleAllClubRakebacks(): Promise<never> {
    throw new Error('Weekly Accounting Is Automatic. Refresh The Recorded Accounting Status.');
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P7-8: DISPUTE AUTO-ESCALATION - RETIRED 2026-09-19
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // escalateStaleDisputes() ran 30 seconds after every page load and then every
  // six hours, in every tab, and it never wrote anything. Not once.
  //
  // MEASURED 2026-09-19 against production. public.disputes grants UPDATE to
  // postgres and service_role only: has_table_privilege('authenticated',
  // 'public.disputes','UPDATE') is FALSE, and so is anon's. RLS is enabled and
  // the table carries exactly ONE policy, disputes_party_or_admin_select, which
  // is SELECT only - there is no UPDATE policy to satisfy even if the grant
  // existed, and authenticated does not bypass RLS. So the UPDATE was 42501
  // permission denied on every call it ever made.
  //
  // The damage was not the failed write. It was that the result was never
  // checked: `escalated++` ran regardless, FinancialAlertService.logWarning
  // fired after it, and fn_raise_financial_alert IS granted to authenticated -
  // measured true - so the alert PERSISTED. Every club admin with a tab open
  // raised a durable "dispute auto-escalated" warning every six hours about a
  // state change that had not happened. That is the same failure as the M4
  // reconciliation and the M7 alert insert above: a counter that reports work
  // it did not do.
  //
  // The 72-hour SLA itself needs no writer and never did. It is a pure function
  // of created_at and the clock, and DisputeManagementPage already derives it
  // at read time in getSlaRemaining() and renders it. The cron was writing down
  // a number the UI was independently computing.
  //
  // Escalation by human judgement is unchanged and still written, by the path
  // that already owns it: fn_dispute_escalate, SECURITY DEFINER, authorised
  // through fn_ca_can_review_integrity, reached via
  // DisputeService.escalateDispute. That one records who escalated and why.
  //
  // A stored generated column was considered and is impossible: Postgres
  // requires an IMMUTABLE generation expression and now() is STABLE.
};

export default FinancialCronService;

// A new authenticated scope must not inherit another account's scan circuit.
let cronIdentity: string | null | undefined;
function cronIdentityReady(): boolean {
  const snapshot = getIdentityDNAStatus();
  // Do not start debt reads/scans while canonical auth initialization is incomplete.
  if (!snapshot?.loaded) return false;
  // A signed-out caller has no business reading agents, and anon holds no
  // SELECT on the table: the read would only ever be "permission denied".
  if (!snapshot.authenticated || !snapshot.userId) return false;
  if (cronIdentity === undefined) cronIdentity = snapshot.authenticated ? snapshot.userId : null;
  return true;
}

masterBus.subscribe('AUTH_STATE_CHANGED', (event) => {
  const nextIdentity = event.payload.isAuthenticated ? event.payload.userId : null;
  if (cronIdentity === nextIdentity) return;
  cronIdentity = nextIdentity;
  FinancialCronService._scopeGeneration++;
  FinancialCronService._suspensionCheckFailed = 0;
  FinancialCronService._suspensionCheckDisabled = false;
  FinancialCronService._lastSuspensionCheck = null;
});
