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
  /**
   * THE PAGE (Dan, 2026-09-11: "I SHOULD GET PUSH NOTIFICATIONS OR TEXT IF
   * ANYTHING INSIDE THE HORSES IS FAILING OR THEY CAN'T PLAY").
   *
   * `raiseEngineAlert` reaches `engine_alerts` and, for a critical, an email.
   * Measured 2026-09-11: every critical the engine raised in seven days was
   * `notified_via = ['email']` and nothing else - `ClubArenaFleetFloorLost`
   * fired twice on 2026-09-10 while Midway ran 0-11 live horses for five
   * hours, and reached no phone. The phone path already exists and delivers:
   * `fn_raise_notification` -> `notifications` -> `push_outbox` (mirrored by
   * trigger) -> the World Hub's per-minute push dispatch -> the web/native
   * push subscription on the phone. `financial_incident` pushes ride it today
   * and were delivered this week. Recipients are the registry Dan owns for
   * exactly this, `ca_incident_recipients` (active, scope platform/technical).
   *
   * Opt-in per alert, critical only, once per fingerprint (the same dedupe the
   * webhook has). A kill storm that fires ten times a day is an email; the
   * fleet unable to play is a page. Nothing here is a fix for anything (10.11):
   * it is the delivery Dan asked for, on the conditions the callers name.
   */
  page?: boolean;
}

/** Test seam: the push mirror's two database calls. */
export interface EnginePageTransport {
  recipients: () => Promise<string[]>;
  notify: (
    userId: string,
    title: string,
    body: string,
    data: Record<string, unknown>
  ) => Promise<void>;
}

let pageTransport: EnginePageTransport | null = null;

async function defaultPageTransport(): Promise<EnginePageTransport> {
  const { supabase } = await import('./supabase/client.js');
  return {
    recipients: async () => {
      const { data, error } = await supabase
        .from('ca_incident_recipients')
        .select('user_id')
        .eq('active', true)
        .in('scope', ['platform', 'technical']);
      if (error) throw error;
      return (data ?? [])
        .map((r) => String((r as { user_id?: string }).user_id ?? ''))
        .filter((v) => v.length > 0);
    },
    notify: async (userId, title, body, data) => {
      const { error } = await supabase.rpc('fn_raise_notification', {
        p_user_id: userId,
        p_type: 'system',
        p_title: title,
        p_message: body,
        p_link: '/hub/club-arena',
        p_data: data,
      });
      if (error) throw error;
    },
  };
}

/**
 * Mirror a paged critical to the phones in the platform recipient registry.
 * Never throws (rule 1). Returns how many recipients were notified.
 */
async function pageRecipients(input: EngineAlertInput, startsAt: string): Promise<number> {
  try {
    const transport = pageTransport ?? (await defaultPageTransport());
    const recipients = await transport.recipients();
    if (recipients.length === 0) {
      console.warn(
        '[engineAlerts] page requested for ' +
          input.alertname +
          ' but ca_incident_recipients has no active platform/technical row - nobody was paged'
      );
      return 0;
    }
    // Title case, no em dashes: the title reaches a phone as a notification.
    const title = 'Horse Fleet Alert: ' + input.alertname;
    const body = (input.summary + (input.description ? ' ' + input.description : '')).slice(0, 480);
    let n = 0;
    for (const userId of recipients) {
      try {
        await transport.notify(userId, title, body, {
          alertname: input.alertname,
          severity: input.severity,
          component: input.component,
          startsAt,
          ...(input.labels ?? {}),
        });
        n++;
      } catch (err) {
        console.warn('[engineAlerts] page to a recipient failed:', (err as Error)?.message);
      }
    }
    return n;
  } catch (err) {
    console.warn('[engineAlerts] page failed:', (err as Error)?.message);
    return 0;
  }
}

/** Test seam: replace the push mirror's database calls. */
export function __setEnginePageTransport(transport: EnginePageTransport | null): void {
  pageTransport = transport;
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

  // The page does not wait on the webhook and the webhook does not wait on
  // the page: two deliveries, two failure domains, one fingerprint.
  if (input.page === true && input.severity === 'critical') {
    void pageRecipients(input, startsAt);
  }

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
