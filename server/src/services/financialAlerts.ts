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
 * @param dedupeKey ONE OPEN ALERT PER THING THAT IS WRONG, not per pass over it.
 *
 * THE DEDUPE KEY WAS ARMED IN THE DATABASE AND UNREACHABLE FROM HERE
 * (2026-09-25). `fn_raise_server_financial_alert` has taken `p_dedupe_key` and
 * `p_entity_id` for as long as it has existed, and it implements exactly the
 * rule its own comment states: a source that already has an UNRESOLVED row for
 * this subject returns that row's id instead of inserting another. This wrapper
 * never passed either parameter, so all 33 call sites that go through it could
 * not reach the guard, and the only flood control left was the RPC's 60-per-
 * minute RATE limit — which a refusal retried on a ~30-minute backoff never
 * trips.
 *
 * Measured on production the day this was fixed: `Tournament.atomic_finish_refused`
 * held 15,426 unresolved criticals across 1,003 tournaments (every one of which
 * had since COMPLETED and paid its pool in full, 91,009.20). The five call sites
 * that bypass this wrapper and call the RPC directly with `p_entity_id` -
 * StableHandExecutor.checkBanks, HorseFleet.stableHandHeartbeat and friends -
 * held ONE row each. Same estate, same day; the only difference was whether the
 * subject key reached the door.
 *
 * Pass a key that names the THING, not the attempt: a tournament id plus the
 * refusal reason, a table id plus a hand number. Omit it only for an alert that
 * is genuinely one-per-occurrence.
 * @param entityId optional subject id recorded alongside; also used as the
 *                 dedupe key when `dedupeKey` is not given.
 */
export async function raiseFinancialAlert(
  severity: FinancialAlertSeverity,
  source: string,
  message: string,
  context: Record<string, unknown> = {},
  dedupeKey?: string | null,
  entityId?: string | null
): Promise<RaiseFinancialAlertResult> {
  try {
    const { data, error } = await supabase.rpc('fn_raise_server_financial_alert', {
      p_severity: severity,
      p_source: source,
      p_message: message,
      p_context: context,
      p_dedupe_key: dedupeKey ?? null,
      p_entity_id: entityId ?? null,
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
