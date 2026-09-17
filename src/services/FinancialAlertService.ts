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

/**
 * Criticals are fetched outside the page budget, so they need a ceiling of
 * their own rather than none at all — an unbounded select is how a browser
 * tab dies on the day something goes badly wrong. Production carries nine
 * unresolved criticals against 472 total rows, so this is roughly fifty times
 * headroom; past it, the page is not the right tool anyway.
 */
const CRITICAL_CEILING = 500;

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

function alertTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59;
}

function readUnresolvedAlert(value: unknown, critical: boolean): FinancialAlert {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Financial alert record could not be verified');
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) ||
      row.id === '00000000-0000-0000-0000-000000000000' ||
      typeof row.severity !== 'string' || !['critical', 'warning', 'info'].includes(row.severity) ||
      (row.severity === 'critical') !== critical || row.resolved !== false ||
      typeof row.source !== 'string' || typeof row.message !== 'string' || !alertTimestamp(row.created_at) ||
      (row.context !== null && (typeof row.context !== 'object' || Array.isArray(row.context)))) {
    throw new Error('Financial alert record could not be verified');
  }
  return { id: row.id, severity: row.severity as AlertSeverity, source: row.source, message: row.message,
    context: (row.context ?? {}) as Record<string, unknown>, resolved: false, createdAt: row.created_at };
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
    // reporter so it reaches error reporting. A dropped critical alert is itself an
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
   * ═════════════════════════════════════════════════════════════════════════
   *  A CRITICAL IS NEVER TRUNCATED AWAY BY NEWER NOISE (2026-08-31)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * This was one query — `resolved = false`, newest first, `.limit(n)` — and
   * the admin page asked for 100. Production had 472 unresolved rows, so 372
   * were never rendered at all, and TWO of the nine unresolved CRITICALS were
   * among them: union treasury conservation breaches from 2026-08-21 and
   * 08-24, sitting unseen for ten days underneath four hundred newer warnings.
   *
   * The page's severity tabs then filtered CLIENT-SIDE over that truncated
   * hundred, so "Critical (7)" was not the number of unresolved criticals, it
   * was the number that happened to survive the cut. A money alarm that can be
   * pushed off the screen by unrelated chatter is not an alarm.
   *
   * Criticals are fetched separately, up to CRITICAL_CEILING and the provider's
   * own row cap. Every returned critical is retained even above `limit`;
   * lower-severity rows use only its remaining budget. This bounded observation
   * must not be labeled as every critical alert or as complete history.
   */
  async getUnresolved(limit = 100): Promise<FinancialAlert[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Financial alert page limit is invalid');
    }
    const COLUMNS = 'id, severity, source, message, context, resolved, created_at';

    const { data: criticals, error: criticalError } = await retryAsync(() =>
      supabase
        .from('financial_alerts')
        .select(COLUMNS)
        .eq('resolved', false)
        .eq('severity', 'critical')
        .order('created_at', { ascending: false })
        .limit(CRITICAL_CEILING)
    );

    // retryAsync observes thrown errors only. A fulfilled PostgREST error is
    // unavailable evidence, never an empty critical queue or an all-clear.
    if (criticalError) throw criticalError;
    if (!Array.isArray(criticals) || criticals.length > CRITICAL_CEILING) {
      throw new Error('Critical financial alerts could not be verified');
    }

    const rest = Math.max(limit - criticals.length, 0);
    let others: unknown[] = [];
    if (rest > 0) {
      const { data, error } = await retryAsync(() =>
        supabase
          .from('financial_alerts')
          .select(COLUMNS)
          .eq('resolved', false)
          .neq('severity', 'critical')
          .order('created_at', { ascending: false })
          .limit(rest)
      );
      if (error) throw error;
      if (!Array.isArray(data) || data.length > rest) {
        throw new Error('Financial alert rows could not be verified');
      }
      others = data;
    }

    const rows = [...criticals.map(row => readUnresolvedAlert(row, true)),
      ...others.map(row => readUnresolvedAlert(row, false))];
    const ids = rows.map(row => row.id!.toLowerCase());
    if (new Set(ids).size !== rows.length) throw new Error('Financial alert rows changed during this read');
    return rows;
  },

  /**
   * Independently observed counts visible to the current authenticated query.
   *
   * The page used to derive its tab counts from the rows it had loaded, so it
   * reported "All (100)" while 472 were open. These are exact head counts: the
   * operator can distinguish loaded rows from each server count. These four
   * reads are not one immutable snapshot or a proof of global permission.
   */
  async getUnresolvedCounts(): Promise<{
    total: number;
    critical: number;
    warning: number;
    info: number;
  }> {
    const countOf = async (severity?: string): Promise<number> => {
      const { count, error } = await retryAsync(() => {
        const q = supabase
          .from('financial_alerts')
          .select('id', { count: 'exact', head: true })
          .eq('resolved', false);
        return severity ? q.eq('severity', severity) : q;
      });
      if (error) throw error;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('Financial alert count could not be verified');
      }
      return count;
    };

    const [total, critical, warning, info] = await Promise.all([
      countOf(),
      countOf('critical'),
      countOf('warning'),
      countOf('info'),
    ]);

    return { total, critical, warning, info };
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
