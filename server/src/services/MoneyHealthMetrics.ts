/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MONEY HEALTH METRICS — the backlog nobody was told about, and the schema
 *  change nobody reviewed
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04). Two findings from the same day, and they are
 * the same failure at two different layers.
 *
 * ── THE BACKLOG ──────────────────────────────────────────────────────────
 * `financial_alerts` held 1,345 unresolved rows, 656 distinct conditions, the
 * oldest fifteen days old. Every reconciler, guard and sweep on the platform
 * writes there and it works perfectly. Nothing has ever reported that the
 * table has contents. The settlement outage found earlier the same day was the
 * identical shape one layer down: the database knew 139,153 times and had no
 * way to say it out loud.
 *
 * AGE is the load-bearing dimension, which is why it is a separate gauge. A
 * critical alert raised a minute ago is the system working exactly as
 * designed. The same alert still open a day later is nobody listening, and
 * only the second one is worth waking someone for.
 *
 * ── THE UNDECLARED TRIGGER ───────────────────────────────────────────────
 * `aaa_skip_noop_update` was attached to `table_seats` with no migration and
 * no review; the first hand-settlement failure followed 0.65 seconds later and
 * 139,153 hands failed to settle over thirteen hours. RULE 2 already forbade
 * it. Nothing enforced it, and the existing guard structurally could not:
 * `check-applied-migrations-are-recorded.mjs` compares schema_migrations
 * against repo files, and an object created by raw SQL never writes a row
 * there, so it asks a question the rogue object is invisible to.
 *
 * `poker_money_undeclared_triggers` is the answer. Any value above zero is an
 * unreviewed schema change on a path that moves chips.
 *
 * ── ITS OWN COLLECTOR, AND FAIL-CLOSED (the SpinMetrics precedent) ────────
 * Two cheap catalog/aggregate reads on one 60s timer, deliberately not folded
 * into another collector: service_role has an 8s statement timeout and a slow
 * read must not be able to blind unrelated gauges. A failed refresh keeps the
 * LAST GOOD snapshot rather than zeroing it — zero undeclared triggers and
 * zero open alerts are both the perfect score, and a collector reporting
 * perfect health while blind is worse than no collector.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export interface MoneyHealthSnapshot {
  unresolvedTotal: number;
  unresolvedCritical: number;
  /** Criticals older than the stale window — the ones nobody has looked at. */
  staleCritical: number;
  /** The table does not deduplicate; 1,345 rows carried 656 conditions. */
  distinctConditions: number;
  /** Hours since the oldest unresolved alert, or null when the table is clear. */
  oldestUnresolvedHours: number | null;
  /** drift_incident:financial_alerts:* — a monitor alerting because an alert exists. */
  metaAlerts: number;
  /** Live triggers on a money/seat table with no declaration. Any value > 0 is an incident. */
  undeclaredTriggers: number | null;
  collectedAt: number;
}

const EMPTY: MoneyHealthSnapshot = {
  unresolvedTotal: 0,
  unresolvedCritical: 0,
  staleCritical: 0,
  distinctConditions: 0,
  oldestUnresolvedHours: null,
  metaAlerts: 0,
  undeclaredTriggers: null,
  collectedAt: 0,
};

/** A critical open longer than this is nobody listening, not the system working. */
export const STALE_ALERT_HOURS = 24;

export class MoneyHealthMetrics {
  private snapshot: MoneyHealthSnapshot = { ...EMPTY };
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private reportedBlind = false;

  constructor(private readonly refreshMs = 60_000) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): MoneyHealthSnapshot {
    return this.snapshot;
  }

  /** Never throws, never zeroes a good snapshot on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [alerts, triggers] = await Promise.all([
        supabase.rpc('fn_financial_alert_health', { p_stale_hours: STALE_ALERT_HOURS }),
        supabase.rpc('fn_undeclared_money_triggers'),
      ]);

      const row = Array.isArray(alerts.data) ? alerts.data[0] : alerts.data;
      if (alerts.error || !row) {
        this.noteFailure(alerts.error?.message ?? 'fn_financial_alert_health returned no row');
        return;
      }

      /** Non-negative integer, or 0. For counts, where 0 is a truthful floor. */
      const n = (v: unknown) => {
        const x = Number(v);
        return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
      };
      /** A real measurement, or null. NEVER 0 — see the header. */
      const f = (v: unknown): number | null => {
        if (v === null || v === undefined) return null;
        const x = Number(v);
        return Number.isFinite(x) ? x : null;
      };

      // The trigger read is allowed to fail on its own without discarding the
      // alert reading — but it must then be ABSENT, never 0. Zero undeclared
      // triggers is the all-clear, and reporting the all-clear because a query
      // failed is the exact lie this file exists to prevent.
      const undeclared = triggers.error
        ? null
        : Array.isArray(triggers.data)
          ? triggers.data.length
          : 0;

      this.snapshot = {
        unresolvedTotal: n(row.unresolved_total),
        unresolvedCritical: n(row.unresolved_critical),
        staleCritical: n(row.stale_critical),
        distinctConditions: n(row.distinct_conditions),
        oldestUnresolvedHours: f(row.oldest_unresolved_age),
        metaAlerts: n(row.meta_alerts),
        undeclaredTriggers: undeclared,
        collectedAt: Date.now(),
      };
      this.consecutiveFailures = 0;
      this.reportedBlind = false;
    } catch (err) {
      this.noteFailure(err instanceof Error ? err.message : String(err));
    } finally {
      this.refreshing = false;
    }
  }

  /** Reported ONCE per outage, not once per attempt. */
  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3 && !this.reportedBlind) {
      this.reportedBlind = true;
      reportError(
        new Error(
          `[MoneyHealthMetrics] ${this.consecutiveFailures} consecutive refresh failures (${reason}) - the money-alert backlog and the undeclared-trigger check are both STALE. poker_money_health_stale_seconds is climbing.`
        ),
        'MoneyHealthMetrics.refresh_failed'
      );
    }
  }

  toPrometheus(): string[] {
    const s = this.snapshot;
    const staleSeconds =
      s.collectedAt === 0 ? 86_400 : Math.max(0, Math.round((Date.now() - s.collectedAt) / 1000));

    const out: string[] = [];
    /** Emit a gauge only when it is a real measurement. */
    const gauge = (name: string, help: string, value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    };

    gauge(
      'poker_financial_alerts_unresolved',
      'Unresolved rows in financial_alerts. 1,345 of these had accumulated by 2026-09-04 with nobody ever told.',
      s.unresolvedTotal
    );
    gauge(
      'poker_financial_alerts_unresolved_critical',
      'Unresolved financial_alerts at severity critical.',
      s.unresolvedCritical
    );
    gauge(
      'poker_financial_alerts_stale_critical',
      `Critical alerts open longer than ${STALE_ALERT_HOURS}h. A critical raised a minute ago is the system working; the same one open a day later is nobody listening.`,
      s.staleCritical
    );
    gauge(
      'poker_financial_alerts_distinct_conditions',
      'Distinct (source, message) pairs among unresolved alerts. The table does not deduplicate - 1,345 rows carried 656 conditions.',
      s.distinctConditions
    );
    gauge(
      'poker_financial_alerts_meta',
      'Unresolved drift_incident:financial_alerts:* rows - a monitor raising an alert because an alert exists.',
      s.metaAlerts
    );
    gauge(
      'poker_financial_alerts_oldest_hours',
      'Age of the oldest unresolved alert, in hours. Absent rather than 0 when the table is clear - an empty backlog has no oldest row, and 0 would read as one raised this second.',
      s.oldestUnresolvedHours
    );
    gauge(
      'poker_money_undeclared_triggers',
      'Triggers live on a money or seat table with no row in ca_declared_money_triggers. Any value above zero is an unreviewed schema change on a chip path - aaa_skip_noop_update was one, and it broke 139,153 hand settlements. ABSENT rather than 0 when the check itself failed.',
      s.undeclaredTriggers
    );

    out.push(
      '# HELP poker_money_health_stale_seconds Age of the last successful money-health reading. 86400 until the first collection succeeds.',
      '# TYPE poker_money_health_stale_seconds gauge',
      `poker_money_health_stale_seconds ${staleSeconds}`
    );

    return out;
  }
}
