/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REPLICATION METRICS — the slot that was falling behind where nobody could see
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04). The realtime replication slot was 136 MB behind
 * and climbing, and the only way anyone had ever learned that was by opening a
 * SQL editor and asking. The host already runs Prometheus, Grafana, Alertmanager
 * and node-exporter, and Prometheus already scrapes this engine every 15s. The
 * series simply did not exist.
 *
 * It matters more than an ordinary missing gauge because logical decoding fails
 * as a SPIRAL, not a cliff. A slot that falls behind must read WAL from disk
 * rather than memory, which is slower, so being behind makes it fall further
 * behind. There is no step change to catch. Players feel it as a lobby that
 * stops updating and a seat that takes seconds to appear, by which time it has
 * usually been degrading for hours.
 *
 * ── ITS OWN COLLECTOR, ON PURPOSE ────────────────────────────────────────
 * This does NOT ride along on fn_spin_metrics or fn_tournament_metrics. Those
 * carry real queries against user tables — fn_spin_metrics cost 3.7s per
 * refresh before two migrations attacked it — and service_role has an 8s
 * statement timeout. If a catalog read shared their round trip, one slow query
 * would take down every gauge in the group. A collector should be able to fail
 * alone.
 *
 * ── FAIL-CLOSED, LOUDLY (the SpinMetrics/TournamentMetrics precedent) ─────
 * A failed read keeps the LAST GOOD snapshot rather than zeroing it, because
 * zero bytes of lag is the perfect score and a collector that reports perfect
 * health while blind is worse than no collector.
 * `poker_pg_replication_metrics_stale_seconds` always tells the truth about how
 * old the reading is, and is already at 86_400 — firing — before the first
 * successful collection.
 *
 * ── AND A GAUGE IS NEVER FAKED ───────────────────────────────────────────
 * A slot with no restart_lsn, or a database in recovery, has no lag to report.
 * That series is OMITTED, never emitted as 0. The alert rules are written
 * against `poker_pg_replication_slots` so that "the collector sees no slots at
 * all" is itself alertable, rather than looking like a database with nothing
 * to replicate.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

/** One slot, as the database describes it. */
export interface ReplicationSlotSnapshot {
  slotName: string;
  slotType: string;
  active: boolean;
  /** Bytes between the slot's restart horizon and the current WAL head, or null. */
  restartLagBytes: number | null;
  /** Bytes between the slot's confirmed flush and the current WAL head, or null. */
  flushLagBytes: number | null;
}

export interface ReplicationMetricsSnapshot {
  slots: ReplicationSlotSnapshot[];
  /** Absolute WAL position in bytes. Prometheus differentiates this with rate(). */
  walPositionBytes: number | null;
  /** Epoch ms of the last SUCCESSFUL collection. 0 means never. */
  collectedAt: number;
}

const EMPTY: ReplicationMetricsSnapshot = {
  slots: [],
  walPositionBytes: null,
  collectedAt: 0,
};

export class ReplicationMetrics {
  private snapshot: ReplicationMetricsSnapshot = { ...EMPTY };
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

  get(): ReplicationMetricsSnapshot {
    return this.snapshot;
  }

  /** Never throws, never zeroes a good snapshot on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { data, error } = await supabase.rpc('fn_replication_slot_metrics');

      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (error || rows.length === 0) {
        this.noteFailure(error?.message ?? 'no rows returned');
        return;
      }

      /** A real measurement, or null. NEVER 0 — see the header. */
      const f = (v: unknown): number | null => {
        if (v === null || v === undefined) return null;
        const x = Number(v);
        return Number.isFinite(x) ? x : null;
      };

      const slots: ReplicationSlotSnapshot[] = rows
        .filter((r: Record<string, unknown>) => typeof r?.slot_name === 'string')
        .map((r: Record<string, unknown>) => ({
          slotName: String(r.slot_name),
          slotType: String(r.slot_type ?? 'unknown'),
          active: r.active === true,
          restartLagBytes: f(r.restart_lag_bytes),
          flushLagBytes: f(r.flush_lag_bytes),
        }));

      if (slots.length === 0) {
        this.noteFailure('rows returned but none carried a slot_name');
        return;
      }

      this.snapshot = {
        slots,
        walPositionBytes: f((rows[0] as Record<string, unknown>).wal_position_bytes),
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
          `[ReplicationMetrics] ${this.consecutiveFailures} consecutive refresh failures (${reason}) - replication gauges are STALE. poker_pg_replication_metrics_stale_seconds is climbing, and nothing is watching the realtime slot, which degrades as a spiral rather than a cliff.`
        ),
        'ReplicationMetrics.refresh_failed'
      );
    }
  }

  /**
   * Prometheus text exposition.
   *
   * `stale_seconds` is emitted even when nothing has ever been collected — and
   * especially then, at a value that is already firing.
   */
  toPrometheus(): string[] {
    const s = this.snapshot;
    const staleSeconds =
      s.collectedAt === 0 ? 86_400 : Math.max(0, Math.round((Date.now() - s.collectedAt) / 1000));

    const out: string[] = [];

    out.push(
      '# HELP poker_pg_replication_slots Replication slots the collector can currently see. 0 means the collector is blind, NOT that the database has nothing to replicate.',
      '# TYPE poker_pg_replication_slots gauge',
      `poker_pg_replication_slots ${s.slots.length}`
    );

    // Emitted once for the whole family, then one series per slot. Prometheus
    // rejects a duplicate HELP/TYPE for the same metric name in one scrape, so
    // these must NOT move inside the loop.
    if (s.slots.some((x) => x.restartLagBytes !== null)) {
      out.push(
        '# HELP poker_pg_replication_slot_restart_lag_bytes Bytes between a slot restart horizon and the WAL head. Absent rather than 0 when there is no reading - zero lag is the perfect score and must never be faked.',
        '# TYPE poker_pg_replication_slot_restart_lag_bytes gauge'
      );
      for (const slot of s.slots) {
        if (slot.restartLagBytes === null) continue;
        out.push(
          `poker_pg_replication_slot_restart_lag_bytes{slot="${slot.slotName}"} ${slot.restartLagBytes}`
        );
      }
    }

    if (s.slots.some((x) => x.flushLagBytes !== null)) {
      out.push(
        '# HELP poker_pg_replication_slot_flush_lag_bytes Bytes between a slot confirmed flush and the WAL head. This is the one that says how far behind the consumer actually is.',
        '# TYPE poker_pg_replication_slot_flush_lag_bytes gauge'
      );
      for (const slot of s.slots) {
        if (slot.flushLagBytes === null) continue;
        out.push(
          `poker_pg_replication_slot_flush_lag_bytes{slot="${slot.slotName}"} ${slot.flushLagBytes}`
        );
      }
    }

    out.push(
      '# HELP poker_pg_replication_slot_active 1 when a slot has a connected consumer. A slot that goes inactive stops advancing and pins WAL on disk.',
      '# TYPE poker_pg_replication_slot_active gauge'
    );
    for (const slot of s.slots) {
      out.push(
        `poker_pg_replication_slot_active{slot="${slot.slotName}",type="${slot.slotType}"} ${slot.active ? 1 : 0}`
      );
    }

    if (s.walPositionBytes !== null && Number.isFinite(s.walPositionBytes)) {
      out.push(
        '# HELP poker_pg_wal_position_bytes Absolute WAL position. Differentiate with rate() for WAL generated per second - the rate is deliberately not computed in the database.',
        '# TYPE poker_pg_wal_position_bytes counter',
        `poker_pg_wal_position_bytes ${s.walPositionBytes}`
      );
    }

    out.push(
      '# HELP poker_pg_replication_metrics_stale_seconds Age of the last successful replication reading. 86400 until the first collection succeeds.',
      '# TYPE poker_pg_replication_metrics_stale_seconds gauge',
      `poker_pg_replication_metrics_stale_seconds ${staleSeconds}`
    );

    return out;
  }
}
