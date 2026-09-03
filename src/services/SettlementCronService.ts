/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT CRON SERVICE — Automated settlement cycle trigger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Checks if the current settlement period has expired and automatically
 * triggers the settlement cycle (close → generate → payout).
 *
 * - Canary check: verify total debits = total credits before finalizing
 * - Bus events for real-time dashboard updates
 * - Idempotent: won't re-trigger if period already processing/settled
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { SettlementService } from './SettlementService';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface CronConfig {
  /** Check interval in ms (default: 60 minutes) */
  checkIntervalMs?: number;
  /** Auto-execute payouts or just close period (default: false for safety) */
  autoExecutePayouts?: boolean;
  /** Require canary balance check before settlement (default: true) */
  requireCanaryCheck?: boolean;
}

export interface CanaryResult {
  passed: boolean;
  totalCredits: number;
  totalDebits: number;
  difference: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const SettlementCronService = {
  timer: null as ReturnType<typeof setInterval> | null,
  isRunning: false,
  lastCheckAt: 0,
  checksPerformed: 0,
  config: {
    checkIntervalMs: 60 * 60 * 1000, // 1 hour
    autoExecutePayouts: false,
    requireCanaryCheck: true,
  } as Required<CronConfig>,

  /**
   * Start the settlement cron service
   */
  start(config: CronConfig = {}): void {
    if (this.timer) this.stop();

    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 60 * 60 * 1000,
      autoExecutePayouts: config.autoExecutePayouts ?? false,
      requireCanaryCheck: config.requireCanaryCheck ?? true,
    };

    console.debug(
      '[SettlementCron] Started - checking every',
      this.config.checkIntervalMs / 1000,
      's'
    );

    // Check immediately on start
    this.check();

    // Then check on interval
    this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);
  },

  /**
   * Stop the cron service
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.debug('[SettlementCron] Stopped');
  },

  /**
   * Get current cron status for admin dashboard / health widget
   */
  getStatus(): {
    isRunning: boolean;
    lastCheckAt: number | null;
    nextCheckMs: number | null;
    checksPerformed: number;
    nextSnapshotAt: string | null;
    nextPayoutAt: string | null;
  } {
    return {
      isRunning: !!this.timer,
      lastCheckAt: this.lastCheckAt,
      nextCheckMs:
        this.lastCheckAt && this.config.checkIntervalMs
          ? Math.max(0, this.config.checkIntervalMs - (Date.now() - this.lastCheckAt))
          : null,
      checksPerformed: this.checksPerformed ?? 0,
      nextSnapshotAt: this.getNextSundaySnapshot().toISOString(),
      nextPayoutAt: this.getNextMondayPayout().toISOString(),
    };
  },

  /**
   * Check if settlement cycle should be triggered
   */
  async check(): Promise<void> {
    if (this.isRunning) {
      console.debug('[SettlementCron] Already running - skipping');
      return;
    }

    this.isRunning = true;
    this.lastCheckAt = Date.now();
    this.checksPerformed++;

    try {
      const period = await SettlementService.getCurrentPeriod();

      // Only trigger if period is past endAt and still 'open'
      if (period.status !== 'open') {
        return;
      }

      const endAt = new Date(period.endAt).getTime();
      if (Date.now() < endAt) {
        return;
      }

      console.debug(`[SettlementCron] Period ${period.id} expired - initiating settlement cycle`);

      masterBus.emit('SETTLEMENT_CYCLE_STARTED', {
        periodId: period.id,
        startedAt: new Date().toISOString(),
      });

      // Step 1: Canary check (if enabled)
      if (this.config.requireCanaryCheck) {
        const canary = await this.runCanaryCheck();
        if (!canary.passed) {
          reportError(
            `CANARY CHECK FAILED: credits=${canary.totalCredits}, debits=${canary.totalDebits}, diff=${canary.difference}`,
            'SettlementCronService.canaryCheckFailed',
            { ...canary }
          );

          // Raise critical alert
          try {
            const { FinancialAlertService } = await import('./FinancialAlertService');
            FinancialAlertService.raise(
              'critical',
              `Settlement canary check failed: credit/debit mismatch of ${canary.difference.toFixed(2)}`,
              'SettlementCronService',
              { ...canary }
            );
          } catch (err) {
            reportError(err, 'SettlementCronService.canaryAuditLog');
          }

          // Automated push/email alert via Supabase edge function
          try {
            const { supabase } = await import('../lib/supabase');
            await supabase.functions.invoke('send-canary-alert', {
              body: {
                type: 'canary_failed',
                totalCredits: canary.totalCredits,
                totalDebits: canary.totalDebits,
                difference: canary.difference,
                periodId: period.id,
                timestamp: new Date().toISOString(),
              },
            });
          } catch (err) {
            reportError(err, 'SettlementCronService.edgeFunctionAlert');
          }

          masterBus.emit('SETTLEMENT_CYCLE_COMPLETED', {
            periodId: period.id,
            status: 'canary_failed',
            canary,
          });
          return;
        }

        console.debug('[SettlementCron] Canary check passed');
      }

      // Step 2: Close period
      await SettlementService.closePeriod(period.id);
      console.debug(`[SettlementCron] Period ${period.id} closed`);

      // Step 3: Execute payouts (if auto-execute is enabled)
      // RAKE-AUDIT 2026-07-24: executeMondayPayouts is a RETIRED NO-OP (returns
      // zeros) — calling it here reported "Payouts complete: 0 agents, 0
      // players, $0" as success while paying nobody. The real weekly payout now
      // runs SERVER-SIDE in the engine daemon (RakebackSettlerService
      // .runWeeklyFinancialClose → settle_club_rakeback +
      // fn_generate_all_credit_invoices), which does not depend on an admin
      // browser tab being open. This client cron only closes the period.
      if (this.config.autoExecutePayouts) {
        console.debug(
          '[SettlementCron] Payout execution is server-authoritative (engine daemon weekly close) - nothing to do client-side'
        );
        masterBus.emit('SETTLEMENT_CYCLE_COMPLETED', {
          periodId: period.id,
          status: 'completed',
        });
      } else {
        console.debug('[SettlementCron] Period closed - manual payout execution required');
        masterBus.emit('SETTLEMENT_CYCLE_COMPLETED', {
          periodId: period.id,
          status: 'closed_pending_payout',
        });
      }
    } catch (err: unknown) {
      reportError(err, 'SettlementCronService.check');
    } finally {
      this.isRunning = false;
    }
  },

  /**
   * Canary check: verify total credits ≈ total debits across all wallets
   */
  async runCanaryCheck(): Promise<CanaryResult> {
    try {
      const { data, error } = await retryAsync(() => supabase.rpc('get_wallet_balance_totals'), 3);

      if (error || !data) {
        // FAIL-CLOSED: If canary RPC doesn't exist, settlement MUST NOT proceed unverified.
        // Raise critical alert and block until the RPC is deployed.
        reportError(
          'Canary RPC not available - BLOCKING settlement (fail-closed)',
          'SettlementCronService.canaryRPCMissing'
        );
        try {
          const { FinancialAlertService } = await import('./FinancialAlertService');
          await FinancialAlertService.logCritical(
            'SettlementCronService.runCanaryCheck',
            'Canary balance-check RPC (get_wallet_balance_totals) is missing - settlement blocked',
            { error: error?.message || 'No data returned' }
          );
        } catch (err) {
          reportError(err, 'SettlementCronService.balanceCheckAudit');
        }
        return { passed: false, totalCredits: 0, totalDebits: 0, difference: -1 };
      }

      const row = Array.isArray(data) ? data[0] : data;
      const totalCredits = Number(row?.total_credits || 0);
      const totalDebits = Number(row?.total_debits || 0);
      const difference = Math.abs(totalCredits - totalDebits);

      // Allow a small tolerance (0.01) for floating point rounding
      const passed = difference < 0.01;

      return { passed, totalCredits, totalDebits, difference };
    } catch (err: unknown) {
      // FAIL-CLOSED: Unexpected errors also block settlement
      reportError(err, 'SettlementCronService.canaryCheckError');
      return { passed: false, totalCredits: 0, totalDebits: 0, difference: -1 };
    }
  },

  /**
   * Get the next Sunday 11:59:59 PM cutoff time (The Sunday Midnight Cutoff Law)
   */
  getNextSundaySnapshot(): Date {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + daysUntilSunday);
    nextSunday.setHours(23, 59, 59, 0);
    // If we're past Sunday 11:59 PM, advance to next week
    if (nextSunday.getTime() <= now.getTime()) {
      nextSunday.setDate(nextSunday.getDate() + 7);
    }
    return nextSunday;
  },

  /**
   * Get the next Monday 4:00 AM payout time (The Monday 4 AM Payout Law)
   */
  getNextMondayPayout(): Date {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 1 = Monday
    let daysUntilMonday = (1 - dayOfWeek + 7) % 7;
    if (daysUntilMonday === 0) {
      // It's Monday — check if 4 AM has passed
      if (now.getHours() >= 4) daysUntilMonday = 7;
    }
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    nextMonday.setHours(4, 0, 0, 0);
    return nextMonday;
  },

  /**
   * Format a countdown string from now to a target date
   */
  formatCountdown(target: Date): string {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) return 'NOW';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    return `${hours}h ${minutes}m`;
  },
};

export default SettlementCronService;
