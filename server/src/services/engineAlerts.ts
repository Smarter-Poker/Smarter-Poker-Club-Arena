/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENGINE ALERTS — the fleet tells you itself
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-22 the engine logged 1,603 kills in six hours, every running cash
 * table died 22-30 times, and nobody was told. It was found by an agent reading
 * the database hours later. Detection without delivery is not monitoring.
 *
 * The delivery path already exists and was built after the same lesson: World
 * Hub's `/api/alerts/engine` was written when "ten poker tables froze
 * permanently and sat dead for 18+ minutes. Nobody was notified, and nobody
 * COULD have been" — 27 Prometheus rules queried metrics that did not exist and
 * Alertmanager routed everything to a null receiver. That endpoint records every
 * alert in `engine_alerts` and emails the criticals through Resend, so it does
 * not depend on any external account being correctly configured.
 *
 * This module is the engine's mouth for it. It speaks the Alertmanager payload
 * the receiver already parses, so nothing on the receiving side changes.
 *
 * ── THREE RULES, EACH FROM SOMETHING THAT WENT WRONG ────────────────────────
 *
 *  1. NEVER THROW, NEVER BLOCK. An alarm that breaks the thing it was warning
 *     about is worse than no alarm. Every path resolves; callers use `void`.
 *
 *  2. FIRE ONCE, RESOLVE ONCE. An alert re-sent every 60s is a log line, and
 *     people mute log lines. State is tracked per fingerprint: a firing alert
 *     is not repeated, and when the condition clears a `resolved` is sent so
 *     the alert closes itself instead of needing a human to notice it stopped.
 *
 *  3. INERT UNTIL CONFIGURED. With no ALERT_WEBHOOK_SECRET this no-ops after
 *     one warning — the same "evidence before behaviour" staging the lease
 *     module used. Nothing is lost meanwhile: every raise also goes to Sentry
 *     through reportError, which is already wired.
 */

import { reportError } from './errorReporter.js';

export type EngineAlertSeverity = 'critical' | 'warning' | 'info';

export interface EngineAlertInput {
  /** Stable name, e.g. 'ClubArenaFleetSilent'. Also the dedupe key with component. */
  alertname: string;
  severity: EngineAlertSeverity;
  /** Subsystem, e.g. 'engine' or 'tournaments'. */
  component: string;
  summary: string;
  description?: string;
  labels?: Record<string, string>;
}

const ALERT_URL = process.env.ALERT_WEBHOOK_URL || 'https://smarter.poker/api/alerts/engine';
const ALERT_SECRET = process.env.ALERT_WEBHOOK_SECRET || '';
const POST_TIMEOUT_MS = 8_000;

/** Fingerprints currently believed to be firing, with when they started. */
const firing = new Map<string, string>();
let warnedUnconfigured = false;

const fingerprintOf = (a: { alertname: string; component: string }) =>
  `${a.alertname}:${a.component}`;

async function post(payload: unknown): Promise<boolean> {
  if (!ALERT_SECRET) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        '[engineAlerts] ALERT_WEBHOOK_SECRET is not set - alerts stay in Sentry only. ' +
          'Set it on the engine host to turn on durable recording + critical email.'
      );
    }
    return false;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-alert-secret': ALERT_SECRET },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok) {
      console.warn('[engineAlerts] receiver returned', res.status);
      return false;
    }
    return true;
  } catch (err) {
    // Rule 1: the alarm failing must never surface as an engine failure.
    console.warn('[engineAlerts] post failed:', (err as Error)?.message);
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Raise an alert. Repeated calls while it is already firing are ignored, so
 * this is safe to call from a polling loop — which is exactly how it is used.
 */
export async function raiseEngineAlert(input: EngineAlertInput): Promise<boolean> {
  const fp = fingerprintOf(input);
  if (firing.has(fp)) return false; // Rule 2: already firing.
  const startsAt = new Date().toISOString();
  firing.set(fp, startsAt);

  // Sentry regardless of whether the webhook is configured or reachable.
  reportError(new Error(input.summary), 'EngineAlert.' + input.alertname, {
    severity: input.severity,
    component: input.component,
    ...(input.labels ?? {}),
  });

  return post({
    alerts: [
      {
        status: 'firing',
        fingerprint: fp,
        labels: {
          alertname: input.alertname,
          severity: input.severity,
          component: input.component,
          ...(input.labels ?? {}),
        },
        annotations: { summary: input.summary, description: input.description ?? '' },
        startsAt,
      },
    ],
  });
}

/**
 * Clear an alert. A no-op unless it is currently firing, so this is equally
 * safe to call every cycle — and it is what stops an alarm needing a human to
 * notice it went away.
 */
export async function resolveEngineAlert(
  alertname: string,
  component: string,
  summary = 'Condition cleared'
): Promise<boolean> {
  const fp = `${alertname}:${component}`;
  const startsAt = firing.get(fp);
  if (startsAt === undefined) return false;
  firing.delete(fp);

  return post({
    alerts: [
      {
        status: 'resolved',
        fingerprint: fp,
        labels: { alertname, severity: 'info', component },
        annotations: { summary },
        startsAt,
        endsAt: new Date().toISOString(),
      },
    ],
  });
}

/** Test seam: which fingerprints this process believes are firing. */
export function firingFingerprints(): string[] {
  return [...firing.keys()].sort();
}

/** Test seam. */
export function __resetEngineAlerts(): void {
  firing.clear();
  warnedUnconfigured = false;
}
