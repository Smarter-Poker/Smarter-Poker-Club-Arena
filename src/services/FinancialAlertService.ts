/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL ALERT SERVICE — Critical Error Logging for Financial Operations
 * ═══════════════════════════════════════════════════════════════════════════════
 * Logs critical financial errors to Supabase for ops visibility and emits
 * bus events for real-time dashboard monitoring.
 *
 * Usage:
 *   import { FinancialAlertService } from './FinancialAlertService';
 *   FinancialAlertService.logCritical('CreditService', 'Wallet rollback failed', { invoiceId, agentId });
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface FinancialAlert {
  id?: string;
  severity: AlertSeverity;
  source: string; // e.g. 'CreditService', 'CashoutService'
  message: string;
  context: Record<string, unknown>;
  resolved: boolean;
  createdAt: string;
}

export const FinancialAlertService = {
  /**
   * Log a critical financial error — persists to DB and emits bus event.
   * For operations where money may be in an inconsistent state.
   */
  async logCritical(
    source: string,
    message: string,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    await this._log('critical', source, message, context);
  },

  /**
   * Log a warning — operation succeeded but with degraded behavior.
   * For retry-able failures or non-blocking audit issues.
   */
  async logWarning(
    source: string,
    message: string,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    await this._log('warning', source, message, context);
  },

  /**
   * Internal: persist alert to DB + emit bus event
   */
  async _log(
    severity: AlertSeverity,
    source: string,
    message: string,
    context: Record<string, unknown>
  ): Promise<void> {
    const alert: Omit<FinancialAlert, 'id'> = {
      severity,
      source,
      message,
      context,
      resolved: false,
      createdAt: new Date().toISOString(),
    };

    // 1. Persist to Supabase for ops dashboard.
    //
    // AUDIT M7 — this used to be a bare `.insert()` into financial_alerts, with
    // an RLS denial (42501) downgraded to console.warn. financial_alerts has
    // RLS on with a SINGLE service_role-scoped policy, so that denial was not
    // the rare non-admin edge case the old comment claimed: it was EVERY client
    // session, always. The table proves it — the newest row predates this audit
    // by months. Every "ops will be alerted" recovery path was writing to
    // /dev/null.
    //
    // Alerts now route through fn_raise_financial_alert, a SECURITY DEFINER
    // raise-only entry point granted to `authenticated` (migration
    // 20260806_fn_raise_financial_alert). Clients can raise an alert but still
    // cannot read, update or resolve one.
    let persisted = false;
    let persistFailure: unknown = null;

    try {
      const { data: alertId, error: rpcErr } = await supabase.rpc('fn_raise_financial_alert', {
        p_severity: alert.severity,
        p_source: alert.source,
        p_message: alert.message,
        p_context: alert.context,
      });
      if (rpcErr) {
        persistFailure = rpcErr;
      } else if (alertId) {
        persisted = true;
      } else {
        // NULL id means the per-reporter throttle tripped. The alert was
        // intentionally dropped by the server, but a CRITICAL must still leave
        // a trace, so treat it as a persistence failure for escalation below.
        persistFailure = new Error('financial alert throttled by fn_raise_financial_alert');
      }
    } catch (err: unknown) {
      persistFailure = err;
    }

    // AUDIT M7 — never swallow. If the durable channel failed and this is a
    // CRITICAL (money may be in an inconsistent state), escalate to the error
    // reporter so it reaches Sentry. A dropped critical alert is itself an
    // incident, not a config-level permission boundary to shrug at.
    if (!persisted && persistFailure) {
      if (severity === 'critical') {
        reportError(persistFailure, 'FinancialAlertService.CRITICAL_ALERT_UNPERSISTED', {
          severity,
          source,
          message,
          context,
        });
      } else {
        console.warn(
          `[FinancialAlert] ${severity} alert not persisted: ${source} - ${message}`,
          persistFailure
        );
      }
    }

    // 2. Emit bus event for real-time dashboard
    try {
      masterBus.emit('FINANCIAL_ALERT', {
        severity,
        source,
        message,
        context,
        timestamp: alert.createdAt,
      });
    } catch (err) {
      console.debug('[FinancialAlertService] Bus emit error:', err);
      // Bus emission failure is non-fatal
    }

    // 3. Log to console.
    // AUDIT M7: warning/info stay at debug level (stripped from production
    // builds), but CRITICAL goes to console.error so it survives the production
    // build and is captured by breadcrumb collection. A critical financial
    // alert must never depend on a single channel.
    const prefix =
      severity === 'critical' ? 'CRITICAL' : severity === 'warning' ? 'WARNING' : 'INFO';
    if (severity === 'critical') {
      console.error(`[FinancialAlert] ${prefix}: ${source}: ${message}`, context);
    } else {
      console.debug(`[FinancialAlert] ${prefix}: ${source}: ${message}`, context);
    }

    // NOTE: Financial alerts are ops-only signals. They are NOT shown as user-facing toasts.
    // They appear on the admin Financial Alerts page (/financial-alerts) via the
    // FINANCIAL_ALERT bus event and Supabase real-time subscription.
  },

  /**
   * Get unresolved alerts (for admin dashboard)
   */
  async getUnresolved(limit = 50): Promise<FinancialAlert[]> {
    const { data } = await retryAsync(() =>
      supabase
        .from('financial_alerts')
        .select('id, severity, source, message, context, resolved, created_at')
        .eq('resolved', false)
        .order('created_at', { ascending: false })
        .limit(limit)
    );

    return (data || []).map((a: any) => ({
      id: a.id,
      severity: a.severity,
      source: a.source,
      message: a.message,
      context: a.context || {},
      resolved: a.resolved,
      createdAt: a.created_at,
    }));
  },

  /**
   * Resolve an alert (mark as handled)
   */
  async resolve(alertId: string): Promise<void> {
    const { error } = await retryAsync(() =>
      supabase
        .from('financial_alerts')
        .update({ resolved: true, resolved_at: new Date().toISOString() })
        .eq('id', alertId)
    );

    if (error) {
      reportError(error, 'FinancialAlertService.resolve', { alertId });
      throw error;
    }
  },

  /**
   * Convenience: raise an alert with severity routing.
   * Maps to logCritical/logWarning based on severity parameter.
   */
  async raise(
    severity: AlertSeverity,
    message: string,
    source: string,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    if (severity === 'critical') {
      await this.logCritical(source, message, context);
    } else {
      await this.logWarning(source, message, context);
    }
  },
};
