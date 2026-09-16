/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVER FINANCIAL ALERTS — Durable, Operator-Visible Money Alarms
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * AUDIT M3 / M7-GAP.
 *
 * M7 gave the browser client a durable alert path (`fn_raise_financial_alert`),
 * but that function hard-requires `auth.uid()` so that every alert is attributable
 * to a signed-in reporter. The game server connects with the SERVICE ROLE key,
 * under which `auth.uid()` is NULL — verified live: calling the M7 function as
 * `service_role` fails with SQLSTATE 28000. So the durable alert path was
 * unreachable from the one process that actually moves money.
 *
 * This module is the server half. It calls `fn_raise_server_financial_alert`
 * (service_role only, flood-guarded per source) and NEVER throws — an alert that
 * blows up the settlement pipeline it was meant to warn about is worse than no
 * alert at all.
 *
 * ESCALATION CONTRACT (mirrors the client FinancialAlertService):
 *   - The RPC returns a uuid on success.
 *   - It returns NULL when throttled (60/min/source).
 *   - Either "no id came back" or "the RPC errored" means the alarm is NOT
 *     durably recorded, so a CRITICAL escalates to reportError (error reporting). A
 *     WARNING or INFO does not — that would just move the noise, not reduce it.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export type FinancialAlertSeverity = 'critical' | 'warning' | 'info';

export interface RaiseFinancialAlertResult {
  /** true when the alert is durably persisted and has a row id. */
  persisted: boolean;
  /** The financial_alerts row id, or null when throttled / failed. */
  alertId: string | null;
}

/**
 * Raise a durable financial alert from the game server.
 *
 * Never throws. Never rejects. Callers can `void` this safely, but money paths
 * should await it so the alert is on disk before the process can be recycled.
 *
 * @param severity 'critical' | 'warning' | 'info' (anything else is coerced to 'info' by the RPC)
 * @param source   dotted subsystem identifier, e.g. 'ServerTableEngine.insurance_ledger_write_failed'
 * @param message  human-readable one-liner for the operator
 * @param context  structured payload — include every id needed to reconstruct the event by hand
 */
export async function raiseFinancialAlert(
  severity: FinancialAlertSeverity,
  source: string,
  message: string,
  context: Record<string, unknown> = {}
): Promise<RaiseFinancialAlertResult> {
  try {
    const { data, error } = await supabase.rpc('fn_raise_server_financial_alert', {
      p_severity: severity,
      p_source: source,
      p_message: message,
      p_context: context,
    });

    if (error) {
      if (severity === 'critical') {
        reportError(error, `financialAlerts.rpc_failed.${source}`, { message, context });
      } else {
        console.warn(`[financialAlerts] ${severity} alert RPC failed for ${source}:`, error);
      }
      return { persisted: false, alertId: null };
    }

    const alertId = typeof data === 'string' && data.length > 0 ? data : null;

    if (!alertId) {
      // No error but no id: the per-source flood guard swallowed it. A throttled
      // CRITICAL is still an unrecorded CRITICAL, so it escalates.
      if (severity === 'critical') {
        reportError(
          new Error(`CRITICAL financial alert was throttled and never persisted: ${message}`),
          `financialAlerts.throttled.${source}`,
          { message, context }
        );
      }
      return { persisted: false, alertId: null };
    }

    return { persisted: true, alertId };
  } catch (e) {
    if (severity === 'critical') {
      reportError(e, `financialAlerts.threw.${source}`, { message, context });
    } else {
      console.warn(`[financialAlerts] ${severity} alert threw for ${source}:`, e);
    }
    return { persisted: false, alertId: null };
  }
}
