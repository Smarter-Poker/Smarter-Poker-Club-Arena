import { getIdentityDNAStatus } from '../core/IdentityDNA';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL CRON SERVICE — Automated Financial Health Checks
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs on configurable intervals to enforce financial integrity:
 * - Ledger reconciliation REMOVED (AUDIT M4) - it is server-side and
 *   snapshot-based now; see fn_snapshot_chip_supply
 * - P2-12: Credit invoice auto-suspension for overdue agents
 * - P2-17: Commission rate change audit trail logging
 *
 * Start via: FinancialCronService.start() in app initialization.
 * Stop via:  FinancialCronService.stop()
 */

import { supabase } from '../lib/supabase';
import { CreditService } from './CreditService';
import { FinancialAlertService } from './FinancialAlertService';
import { masterBus } from '../core/MasterBus';
// [MIGRATION] rakebackEngine removed — server-authoritative (Step 6). Settlement via Supabase RPC.
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

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
  _reconciliationTimer: null as ReturnType<typeof setInterval> | null,
  _suspensionTimer: null as ReturnType<typeof setInterval> | null,
  _disputeEscalationTimer: null as ReturnType<typeof setInterval> | null,
  _rakebackSettlementTimer: null as ReturnType<typeof setInterval> | null,
  _startupTimer: null as ReturnType<typeof setTimeout> | null,
  _isRunning: false,
  _scopeGeneration: 0,
  _lastReconciliation: null as ReconciliationResult | null,
  _lastSuspensionCheck: null as SuspensionCheckResult | null,
  /** FIX-216: Circuit breaker — disable suspension checks after persistent failures */
  _suspensionCheckFailed: 0,
  _suspensionCheckDisabled: false,
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
    this._scopeGeneration++;
    this._suspensionCheckFailed = 0;
    this._suspensionCheckDisabled = false;
    this._lastSuspensionCheck = null;

    this._config = {
      reconciliationIntervalMs: config.reconciliationIntervalMs ?? 24 * 60 * 60 * 1000,
      suspensionCheckIntervalMs: config.suspensionCheckIntervalMs ?? 6 * 60 * 60 * 1000,
      autoSuspendEnabled: config.autoSuspendEnabled ?? false,
    };

    console.debug(
      '[FinancialCron] Started - reconciliation every',
      this._config.reconciliationIntervalMs / 3600000,
      'h, suspension check every',
      this._config.suspensionCheckIntervalMs / 3600000,
      'h'
    );

    // Delay first run by 30s — avoids noisy failures during app startup
    // when database connections may not be fully established
    // AUDIT M4: reconciliation is NO LONGER scheduled here. It ran in every
    // browser session, and under RLS a browser sees exactly one wallet - its
    // own - so `minted - wallets - locked` evaluated to
    // `0 - (that user's balance) - 0`. The "discrepancy" it reported was simply
    // the caller's own balance, negated, and it wrote that to
    // financial_health_checks: 1,049 rows between 2026-03-13 and 2026-08-05,
    // 1,039 of them failing, with 199 distinct values. A check that fails 99% of
    // the time is worse than no check, because it teaches everyone to ignore the
    // channel M3 built.
    //
    // Chip-supply reconciliation is now server-side and snapshot-based
    // (fn_snapshot_chip_supply, service_role only). See the migration for why it
    // measures deltas between snapshots rather than asserting balance against a
    // genesis figure that does not exist.
    this._startupTimer = setTimeout(() => {
      this.runSuspensionCheck();
      this.escalateStaleDisputes();
    }, 30_000);
    this._suspensionTimer = setInterval(
      () => this.runSuspensionCheck(),
      this._config.suspensionCheckIntervalMs
    );
    // Run dispute escalation every 6 hours (same cadence as suspension checks)
    this._disputeEscalationTimer = setInterval(
      () => this.escalateStaleDisputes(),
      this._config.suspensionCheckIntervalMs
    );

    // WEIGHTED RAKE SWEEP 2026-08-29: the weekly rakeback settlement is NO
    // LONGER scheduled from the browser. It duplicated two server-side owners
    // that already run it — the pg_cron pair `union-weekly-rakeback-recompute`
    // (Sun 23:40 UTC) / `union-weekly-rakeback-close` (Mon 00:10 UTC) and the
    // engine's RakebackSettlerService sweep — and it fired from whichever
    // user's tab happened to be open 7 days after page load, which is not a
    // schedule, it is a coin flip. settle_club_rakeback is also owner-gated
    // in the database now, so a random member's browser could no longer close
    // another club's periods anyway. settleAllClubRakebacks() remains callable
    // for an explicit admin action; nothing schedules it.

    this._isRunning = true;
  },

  /**
   * Stop all cron jobs
   */
  stop(): void {
    this._scopeGeneration++;
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
   * Check all agents with credit lines for overdue invoices.
   * If autoSuspendEnabled, automatically suspend agents with overdue debt.
   * Otherwise, just log warnings for ops review.
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

    // Generate this week's credit invoices BEFORE checking for overdue ones. This is the
    // reliable trigger for the credit-invoice subsystem: fn_generate_all_credit_invoices
    // anchors period_end to the week boundary and is idempotent per (agent, week), so
    // running it on the 6h suspension cadence converges to exactly one invoice per agent
    // per week. Agents with debt therefore always have a current invoice to view/pay in
    // the portal, and this suspension check then acts on genuinely overdue ones.
    // (For a fully autonomous server-side trigger independent of an admin session, see the
    // Open Claw cron handoff — this client cadence covers the common case.)
    try {
      const { error: genErr } = await supabase.rpc('fn_generate_all_credit_invoices');
      if (!current()) return unknown();
      if (genErr) {
        unavailable = true;
        reportError(genErr, 'FinancialCronService.generateCreditInvoices');
      }
    } catch (e) {
      if (!current()) return unknown();
      unavailable = true;
      reportError(e, 'FinancialCronService.generateCreditInvoices.exception');
    }

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

  // ─────────────────────────────────────────────────────────────────────────────
  // WEEKLY RAKEBACK SETTLEMENT — Persist in-memory rakeback to DB
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Settle rakeback for ALL active clubs. Queries the clubs table for active clubs,
   * then settles rakeback via Supabase RPC for each, which persists accumulated
   * rakeback to the `rakeback_periods` table for player claiming via RakebackPage.
   */
  async settleAllClubRakebacks(): Promise<{
    clubsSettled: number;
    totalDistributed: number;
  }> {
    let clubsSettled = 0;
    let totalDistributed = 0;
    let periodsRemaining = 0;

    try {
      const { data: clubs } = await supabase
        .from('clubs')
        .select('id')
        .eq('status', 'active')
        .limit(QUERY_LIMITS.MODERATE);

      if (!clubs || clubs.length === 0) return { clubsSettled, totalDistributed };

      for (const club of clubs) {
        try {
          // Server-authoritative: settle rakeback via Supabase RPC
          // settle_club_rakeback returns `total_payout`. It has never returned
          // `total_distributed`, which is what this read until 2026-09-07 - so
          // clubsSettled and totalDistributed were always 0 and the debug line
          // below never fired, whatever the RPC actually paid.
          //
          // It is also BOUNDED since 2026-09-07 (40 periods / ~4s per call), so
          // one call per club no longer drains a club. Nothing schedules this
          // method - start() retired it, the durable drain is the engine's
          // RakebackSettlerService.runRakebackDrain - so it is left as a single
          // honest pass for an explicit admin action, and it reports what is
          // left rather than implying it finished.
          const { data: settlement, error: settleErr } = await supabase.rpc(
            'settle_club_rakeback',
            { p_club_id: club.id }
          );
          if (settleErr) {
            reportError(settleErr, 'FinancialCronService.settleClubRakeback', {
              clubId: club.id,
            });
          } else if (settlement?.success === true) {
            const paid = Number(settlement.total_payout ?? 0);
            if (paid > 0) {
              clubsSettled++;
              totalDistributed += paid;
            }
            periodsRemaining += Number(settlement.periods_remaining ?? 0);
          } else if (settlement) {
            // A refusal arrives as HTTP 200 with success:false.
            reportError(
              new Error(`settle_club_rakeback refused: ${JSON.stringify(settlement)}`),
              'FinancialCronService.settleClubRakeback',
              { clubId: club.id }
            );
          }
        } catch (err) {
          reportError(err, 'FinancialCronService.settleClubRakeback', {
            clubId: club.id,
          });
        }
      }

      if (clubsSettled > 0 || periodsRemaining > 0) {
        console.debug(
          `[FinancialCron] Rakeback settled for ${clubsSettled} clubs, total distributed: ` +
            `${totalDistributed.toFixed(2)}; ${periodsRemaining} period(s) still pending ` +
            `(one bounded pass - the engine settler drains the rest)`
        );
      }
    } catch (err) {
      reportError(err, 'FinancialCronService.settleAllClubRakebacks');
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
          reportError(e, 'FinancialCronService.escalateStaleDisputes', {
            disputeId: dispute.id,
          });
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
      reportError(err, 'FinancialCronService.escalateStaleDisputes');
    }
    return escalated;
  },
};

export default FinancialCronService;

// A new authenticated scope must not inherit another account's scan circuit.
let cronIdentity: string | null | undefined;
function cronIdentityReady(): boolean {
  const snapshot = getIdentityDNAStatus();
  // Do not start debt reads/scans while canonical auth initialization is incomplete.
  if (!snapshot?.loaded) return false;
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
