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
 * alert in `engine_alerts`, which the Codex incident task consumes.
 *
 * This module is the engine's mouth for it. It speaks the Alertmanager payload
 * the receiver already parses, with an immutable event ID and durable receipt.
 *
 * ── THREE RULES, EACH FROM SOMETHING THAT WENT WRONG ────────────────────────
 *
 *  1. NEVER THROW, NEVER BLOCK. An alarm that breaks the thing it was warning
 *     about is worse than no alarm. Every path resolves; callers use `void`.
 *
 *  2. FIRE ONCE, RESOLVE ONCE. An alert re-sent every 60s is a log line, and
 *     people mute log lines. Observation state and pending delivery are
 *     journaled per fingerprint: a firing alert
 *     is not repeated, and when the condition clears a `resolved` is sent so
 *     the alert closes itself instead of needing a human to notice it stopped.
 *
 *  3. PERSIST BEFORE DELIVERY. Missing configuration or an unavailable receiver
 *     leaves events pending on the host-mounted journal. Startup and timer
 *     retries preserve the original event IDs and firing/recovery order.
 *     error reporting reporting is an additional signal, not the durability mechanism.
 */

import { reportError } from './errorReporter.js';
import { EngineAlertDelivery, MemoryAlertJournal } from './engineAlertDelivery.js';
import {
  FileAlertJournal,
  emptyAlertJournal,
  type AlertJournalStore,
  type JournalAlert,
} from './engineAlertJournal.js';

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
  /** Retain page priority in Codex; operational alerts never mirror to phones. */
  page?: boolean;
}

const POST_TIMEOUT_MS = 8_000;
let warnedUnconfigured = false;

// ── THE PRODUCER IS OBSERVABLE (2026-09-21) ──────────────────────────────────
//
// On 2026-09-19/20 this module went 17.8 hours without a delivery, and nobody
// could tell "down" from "quiet" without ssh-ing to the host and reading
// journal.json: it logged only failures and exported no metric. An alarm that
// cannot itself be alarmed on is the 2026-08-15 lesson one level up.
//
// These are read on every /metrics scrape from memory alone - no journal read,
// no network - and rendered by engineAlertPrometheusLines(), which
// GameServer.getPrometheusMetrics() spreads into the exposition. The rules
// that read them are the engine-alert-producer group in
// infra/monitoring/alert-rules.yml. Every series is present from the first
// scrape, so absent() means the exporter is down, never "nothing happened".
let deliveryFailuresTotal = 0;
/** `nextSequence` as it last crossed the journal store. The transport keeps
 * its state private, but every transition saves the whole state through the
 * store, so this is current after every event. 0 until the first load. In
 * production the transport loads within milliseconds of construction, long
 * before the first scrape; in tests it loads on the first observation. */
let journalSequence = 0;

function observingJournal(store: AlertJournalStore): AlertJournalStore {
  return {
    async load() {
      const state = await store.load();
      journalSequence = state.nextSequence;
      return state;
    },
    async save(state) {
      await store.save(state);
      journalSequence = state.nextSequence;
    },
  };
}

function logDeliveryFailure(message: string, detail?: string): void {
  deliveryFailuresTotal += 1;
  // Closed or saturated stdout must not make an alert or shutdown throw.
  try {
    console.warn(message, ...(detail === undefined ? [] : [detail]));
  } catch {
    /* journal retains evidence */
  }
}

async function post(alert: JournalAlert): Promise<boolean> {
  const secret = process.env.ALERT_WEBHOOK_SECRET?.trim();
  if (!secret) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logDeliveryFailure(
        '[engineAlerts] ALERT_WEBHOOK_SECRET is not set; alerts remain in the durable journal'
      );
    }
    return false;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    const response = await fetch(
      process.env.ALERT_WEBHOOK_URL || 'https://smarter.poker/api/alerts/engine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-alert-secret': secret },
        body: JSON.stringify({ alerts: [alert] }),
        signal: ctl.signal,
      }
    );
    if (!response.ok) throw new Error(`receiver returned HTTP ${response.status}`);
    // World Hub acknowledges only after engine_alerts and its immutable event
    // receipt commit together. The Codex task consumes that durable history.
    // A generic proxy 200, empty body, or recorded:0 is not a storage receipt.
    const receipt: unknown = await response.json();
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      !('ok' in receipt) ||
      receipt.ok !== true ||
      !('recorded' in receipt) ||
      receipt.recorded !== 1 ||
      !('db' in receipt) ||
      receipt.db !== 'ok' ||
      !('destination' in receipt) ||
      receipt.destination !== 'codex'
    ) {
      throw new Error('receiver did not acknowledge durable Codex storage');
    }
    const ids = 'receipts' in receipt ? receipt.receipts : null;
    const stored = Array.isArray(ids) && ids.length === 1 ? ids[0] : null;
    if (
      !stored ||
      typeof stored !== 'object' ||
      !Number.isSafeInteger(stored.id) ||
      stored.id <= 0 ||
      stored.event_id !== alert.labels.engine_alert_event_id
    ) {
      throw new Error('receiver did not acknowledge this immutable engine event');
    }
    return true;
  } catch (error) {
    logDeliveryFailure('[engineAlerts] delivery pending:', (error as Error)?.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function createDelivery(store?: AlertJournalStore): EngineAlertDelivery {
  return new EngineAlertDelivery({
    store: observingJournal(
      store ??
        new FileAlertJournal(
          process.env.ENGINE_ALERT_JOURNAL_DIR || '/var/lib/club-arena/engine-alerts'
        )
    ),
    post,
    // Tests exercise scheduling explicitly through the transport class.
    automatic: process.env.NODE_ENV !== 'test',
    report: (error) =>
      reportError(
        error instanceof Error ? error : new Error(String(error)),
        'EngineAlert.delivery'
      ),
    raised: (input) => {
      reportError(new Error(input.summary), 'EngineAlert.' + input.alertname, {
        severity: input.severity,
        component: input.component,
        ...(input.labels ?? {}),
      });
    },
  });
}
let delivery = createDelivery();

/** Queue each observed transition durably. True means this event received the
 * durable HTTP acknowledgement; false can also mean it remains queued. */
export async function raiseEngineAlert(input: EngineAlertInput): Promise<boolean> {
  return delivery.raise(input);
}
export async function resolveEngineAlert(
  alertname: string,
  component: string,
  summary = 'Condition cleared'
): Promise<boolean> {
  return delivery.resolve(alertname, component, summary);
}
export function firingFingerprints(): string[] {
  return delivery.snapshot().firing;
}
export function engineAlertDeliverySnapshot() {
  return delivery.snapshot();
}
/** Read-only summary for the existing public health surface; no event payloads. */
export function engineAlertDeliveryHealth() {
  const { firing, ...snapshot } = delivery.snapshot();
  return { ...snapshot, active: firing.length };
}

/** Prometheus lines for the producer itself. Always present, so a zero is
 * visible rather than absent; memory only, never the journal or the network. */
export function engineAlertPrometheusLines(): string[] {
  const snapshot = delivery.snapshot();
  const acknowledged = snapshot.lastAcknowledgedAt
    ? Date.parse(snapshot.lastAcknowledgedAt)
    : Number.NaN;
  return [
    '# HELP poker_engine_alerts_journal_sequence Next event sequence in the durable engine-alert journal; unchanged across a window means no alert transition was journaled',
    '# TYPE poker_engine_alerts_journal_sequence gauge',
    `poker_engine_alerts_journal_sequence ${journalSequence}`,
    '# HELP poker_engine_alerts_pending Engine alert events journaled but not yet durably acknowledged by World Hub /api/alerts/engine',
    '# TYPE poker_engine_alerts_pending gauge',
    `poker_engine_alerts_pending ${snapshot.pending}`,
    '# HELP poker_engine_alerts_active Engine alert episodes currently firing (one per alertname:component fingerprint)',
    '# TYPE poker_engine_alerts_active gauge',
    `poker_engine_alerts_active ${snapshot.firing.length}`,
    '# HELP poker_engine_alerts_last_delivery_timestamp_seconds Unix time of the last durably acknowledged delivery; 0 when none since this process started',
    '# TYPE poker_engine_alerts_last_delivery_timestamp_seconds gauge',
    `poker_engine_alerts_last_delivery_timestamp_seconds ${
      Number.isFinite(acknowledged) ? Math.floor(acknowledged / 1000) : 0
    }`,
    '# HELP poker_engine_alerts_delivery_failures_total Delivery failures logged by the producer: receiver error or timeout, unacknowledged receipt, missing ALERT_WEBHOOK_SECRET, unconfirmed shutdown persistence',
    '# TYPE poker_engine_alerts_delivery_failures_total counter',
    `poker_engine_alerts_delivery_failures_total ${deliveryFailuresTotal}`,
  ];
}

/** Called only after gameplay ownership has been released. No network wait;
 * a broken filesystem cannot extend the existing shutdown deadline. */
export async function persistEngineAlertsBeforeExit(budgetMs = 1000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const persisted = await Promise.race([
      delivery.persistBeforeExit(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
    if (!persisted)
      logDeliveryFailure('[engineAlerts] shutdown journal persistence was not confirmed');
    return persisted;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam: replacing a process never deletes the prior journal's evidence. */
export function __setEngineAlertJournal(store: AlertJournalStore): void {
  delivery.stop();
  delivery = createDelivery(store);
  journalSequence = 0; // the new store's sequence is unknown until it loads
}
export function __resetEngineAlerts(): void {
  __setEngineAlertJournal(new MemoryAlertJournal(emptyAlertJournal()));
  warnedUnconfigured = false;
  deliveryFailuresTotal = 0;
}
