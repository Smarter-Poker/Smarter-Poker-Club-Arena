import { reportError } from '../services/errorReporter.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ENGINE TELEMETRY — Production Observability Service
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tracks performance and health metrics across all engine instances:
 * - Per-table: hands/hour, avg hand duration, action timer utilization
 * - Per-engine: avg deal time, avg evaluation time, cache hit ratio
 * - Global: active tables, active players, total hands dealt
 * - Periodic snapshot via optional onEvent callback
 *
 * Ported from client: src/engine/EngineTelemetry.ts (246 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableMetrics {
  tableId: string;
  handsDealt: number;
  handsPerHour: number;
  avgHandDurationMs: number;
  avgDealTimeMs: number;
  avgEvalTimeMs: number;
  timerUtilization: number; // % of action timers that expired vs acted
  lastHandAt: number;
}

export interface GlobalMetrics {
  activeTables: number;
  activePlayers: number;
  totalHandsDealt: number;
  avgHandsPerHour: number;
  avgHandDurationMs: number;
  cacheHitRatio: number;
  uptime: number; // ms since engine started
}

export interface TelemetrySnapshot {
  timestamp: number;
  global: GlobalMetrics;
  tables: TableMetrics[];
}

export type TelemetryEventType = 'ENGINE_TELEMETRY';

export interface TelemetryEvent {
  type: TelemetryEventType;
  [key: string]: unknown;
}

interface HandTiming {
  dealMs: number;
  evalMs: number;
  totalMs: number;
  timestamp: number;
}

// Bible V8 §9.1 Performance Thresholds
const ACTION_PROCESSING_THRESHOLD_MS = 50; // §9.1.1: < 50ms server-side
const ACTION_SAMPLE_WINDOW_MS = 5 * 60_000;
const BROADCAST_LATENCY_THRESHOLD_MS = 100; // §9.1.2: < 100ms to all clients

interface ActionTiming {
  tableId: string;
  userId: string;
  action: string;
  processingMs: number;
  broadcastMs: number | null; // null if not measured
  timestamp: number;
  exceededThreshold: boolean;
  sampledAtMonotonicMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE TELEMETRY CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class EngineTelemetry {
  private startedAt: number = Date.now();
  // Per-table hand durations (keep last 100 per table)
  private tableTimings: Map<string, HandTiming[]> = new Map();
  // Monotonic hand counts. NOT derived from tableTimings, which is a capped
  // ring buffer — see the note in recordHandTiming().
  private handsRecorded: number = 0;
  private actionsRecorded = 0;
  private lastHandRecordedAt: number | null = null;
  private lastActionRecordedAt: number | null = null;
  private lastActionRecordedMonotonicMs: number | null = null;
  private lastHandRecordedMonotonicMs: number | null = null;
  private handsRecordedByTable: Map<string, number> = new Map();
  // Per-table player counts
  private tablePlayers: Map<string, number> = new Map();
  // Per-table expired vs acted timer counts
  private timerExpired: Map<string, number> = new Map();
  private timerActed: Map<string, number> = new Map();
  // Global cache stats
  private cacheHits: number = 0;
  private cacheMisses: number = 0;
  // Bible V8 §9.1 action-level performance tracking
  private actionTimings: ActionTiming[] = [];
  private actionThresholdViolations: number = 0;
  private broadcastThresholdViolations: number = 0;
  // Periodic emit interval
  private emitInterval: ReturnType<typeof setInterval> | null = null;
  private onEvent?: (event: TelemetryEvent) => void;

  constructor(onEvent?: (event: TelemetryEvent) => void) {
    this.onEvent = onEvent;

    // Auto-emit telemetry every 60 seconds
    this.emitInterval = setInterval(() => {
      this.emitSnapshot();
    }, 60_000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECORDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record timing data for a completed hand.
   */
  recordHandTiming(tableId: string, dealMs: number, evalMs: number, totalMs: number): void {
    let timings = this.tableTimings.get(tableId);
    if (!timings) {
      timings = [];
      this.tableTimings.set(tableId, timings);
    }

    timings.push({ dealMs, evalMs, totalMs, timestamp: Date.now() });

    // Keep only last 100 timings per table
    if (timings.length > 100) {
      timings.splice(0, timings.length - 100);
    }

    // A COUNTER MUST NOT BE A RING BUFFER'S LENGTH (2026-09-07).
    // `poker_hands_dealt_total` is declared `# TYPE counter` and was computed
    // from `timings.length` above, which is capped at 100. Every table on the
    // fleet reaches 100 within a couple of minutes of dealing and then never
    // moves again, so `increase(poker_hands_dealt_total[5m])` is 0 FOREVER on
    // a perfectly healthy engine — and `EngineNoHandsDealt` /
    // `EngineHandsStopped` are written on exactly that expression. Measured
    // 2026-09-07: `EngineHandsStopped` had been firing continuously for over
    // three hours while the fleet dealt ~27,000 hands an hour.
    // This is the real monotonic count, and it is what the counter reads now.
    this.handsRecorded++;
    this.lastHandRecordedAt = Date.now();
    this.lastHandRecordedMonotonicMs = performance.now();
    this.handsRecordedByTable.set(tableId, (this.handsRecordedByTable.get(tableId) || 0) + 1);
    EngineTelemetry.bankEngineCounters(this);
  }

  /**
   * Record player count for a table.
   */
  recordPlayerCount(tableId: string, count: number): void {
    this.tablePlayers.set(tableId, count);
  }

  /**
   * Record that an action timer expired (player didn't act).
   */
  recordTimerExpired(tableId: string): void {
    this.timerExpired.set(tableId, (this.timerExpired.get(tableId) || 0) + 1);
  }

  /**
   * Record that a player acted before timer expired.
   */
  recordTimerActed(tableId: string): void {
    this.timerActed.set(tableId, (this.timerActed.get(tableId) || 0) + 1);
  }

  /**
   * Record evaluator cache hit/miss.
   */
  recordCacheHit(): void {
    this.cacheHits++;
  }
  recordCacheMiss(): void {
    this.cacheMisses++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BIBLE V8 §9.1 — Action Performance Instrumentation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record action processing time (Bible V8 §9.1.1: < 50ms).
   * Called after every player action is processed.
   */
  static measureAcceptedAction(
    telemetry: EngineTelemetry,
    tableId: string,
    userId: string,
    action: string,
    apply: () => boolean
  ): boolean {
    const started = performance.now();
    // Only synchronous rule execution/broadcast work is measured. Human wait,
    // horse computation and visible pacing have already finished at this boundary.
    const applied = apply();
    if (applied) {
      try {
        telemetry.recordActionProcessingTime(tableId, userId, action, performance.now() - started);
      } catch {
        // An accepted poker action must retain its result if telemetry fails.
      }
    }
    return applied;
  }

  recordActionProcessingTime(
    tableId: string,
    userId: string,
    action: string,
    processingMs: number,
    broadcastMs: number | null = null
  ): void {
    if (!Number.isFinite(processingMs) || processingMs < 0) return;
    if (broadcastMs !== null && (!Number.isFinite(broadcastMs) || broadcastMs < 0))
      broadcastMs = null;
    this.actionsRecorded++;
    this.lastActionRecordedAt = Date.now();
    this.lastActionRecordedMonotonicMs = performance.now();
    const processingExceeded = processingMs > ACTION_PROCESSING_THRESHOLD_MS;
    const broadcastExceeded = broadcastMs !== null && broadcastMs > BROADCAST_LATENCY_THRESHOLD_MS;
    const exceeded = processingExceeded || broadcastExceeded;
    if (processingExceeded) this.actionThresholdViolations++;
    if (broadcastExceeded) this.broadcastThresholdViolations++;
    EngineTelemetry.bankEngineCounters(this);

    if (exceeded) {
      // Log warning for threshold violations
      const parts = [`§9.1 PERF WARNING: ${action} on ${tableId}`];
      if (processingMs > ACTION_PROCESSING_THRESHOLD_MS) {
        parts.push(`processing=${processingMs}ms (>${ACTION_PROCESSING_THRESHOLD_MS}ms)`);
      }
      if (broadcastMs !== null && broadcastMs > BROADCAST_LATENCY_THRESHOLD_MS) {
        parts.push(`broadcast=${broadcastMs}ms (>${BROADCAST_LATENCY_THRESHOLD_MS}ms)`);
      }
      console.warn(parts.join(' | '));
    }

    this.actionTimings.push({
      tableId,
      userId,
      action,
      processingMs,
      broadcastMs,
      timestamp: Date.now(),
      exceededThreshold: exceeded,
      sampledAtMonotonicMs: this.lastActionRecordedMonotonicMs,
    });

    // Keep last 500 action timings
    if (this.actionTimings.length > 500) {
      this.actionTimings.splice(0, this.actionTimings.length - 500);
    }
  }

  /**
   * Get §9.1 performance summary: avg processing time, avg broadcast time,
   * threshold violation counts.
   */
  getPerformanceSummary(): {
    avgProcessingMs: number;
    avgBroadcastMs: number;
    p95ProcessingMs: number;
    p95BroadcastMs: number;
    actionCount: number;
    processingViolations: number;
    broadcastViolations: number;
    broadcastSampleCount: number;
    totalActionsRecorded: number;
    lastActionAt: number | null;
    sampleWindowMs: number;
  } {
    const now = performance.now();
    const timings = this.actionTimings.filter(
      (t) => now - t.sampledAtMonotonicMs <= ACTION_SAMPLE_WINDOW_MS
    );
    if (timings.length === 0) {
      return {
        avgProcessingMs: 0,
        avgBroadcastMs: 0,
        p95ProcessingMs: 0,
        p95BroadcastMs: 0,
        actionCount: 0,
        broadcastSampleCount: 0,
        totalActionsRecorded: this.actionsRecorded,
        lastActionAt: this.lastActionRecordedAt,
        sampleWindowMs: ACTION_SAMPLE_WINDOW_MS,
        processingViolations: this.actionThresholdViolations,
        broadcastViolations: this.broadcastThresholdViolations,
      };
    }

    const processingTimes = timings.map((t) => t.processingMs).sort((a, b) => a - b);
    const broadcastTimes = timings
      .filter((t) => t.broadcastMs !== null)
      .map((t) => t.broadcastMs as number)
      .sort((a, b) => a - b);

    const p95Index = Math.floor(processingTimes.length * 0.95);
    const bP95Index = Math.floor(broadcastTimes.length * 0.95);

    return {
      avgProcessingMs: Math.round(
        processingTimes.reduce((s, v) => s + v, 0) / processingTimes.length
      ),
      avgBroadcastMs:
        broadcastTimes.length > 0
          ? Math.round(broadcastTimes.reduce((s, v) => s + v, 0) / broadcastTimes.length)
          : 0,
      p95ProcessingMs: processingTimes[p95Index] ?? 0,
      p95BroadcastMs: broadcastTimes[bP95Index] ?? 0,
      actionCount: timings.length,
      broadcastSampleCount: broadcastTimes.length,
      totalActionsRecorded: this.actionsRecorded,
      lastActionAt: this.lastActionRecordedAt,
      sampleWindowMs: ACTION_SAMPLE_WINDOW_MS,
      processingViolations: this.actionThresholdViolations,
      broadcastViolations: this.broadcastThresholdViolations,
    };
  }

  /**
   * Remove tracking for a table (table closed).
   */
  removeTable(tableId: string): void {
    this.tableTimings.delete(tableId);
    this.tablePlayers.delete(tableId);
    this.timerExpired.delete(tableId);
    this.timerActed.delete(tableId);
    this.handsRecordedByTable.delete(tableId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SNAPSHOT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a full telemetry snapshot.
   */
  getSnapshot(): TelemetrySnapshot {
    const tables: TableMetrics[] = [];
    let totalHands = 0;
    let totalDuration = 0;
    let totalPlayers = 0;

    for (const [tableId, timings] of this.tableTimings) {
      if (timings.length === 0) continue;

      // `sampled` is the ring-buffer length — the right denominator for an
      // AVERAGE and for a RATE. `handsDealt` is the monotonic lifetime count —
      // the right value for a COUNTER. Conflating the two is what pinned
      // poker_hands_dealt_total at 100; keep them apart.
      const sampled = timings.length;
      const handsDealt = this.handsRecordedByTable.get(tableId) ?? sampled;
      totalHands += handsDealt;

      // Avg timings
      const avgDealMs = timings.reduce((s, t) => s + t.dealMs, 0) / sampled;
      const avgEvalMs = timings.reduce((s, t) => s + t.evalMs, 0) / sampled;
      const avgTotal = timings.reduce((s, t) => s + t.totalMs, 0) / sampled;
      totalDuration += avgTotal;

      // Hands per hour (based on first and last timing in the sampled window)
      const span = timings[timings.length - 1].timestamp - timings[0].timestamp;
      const handsPerHour = span > 0 ? Math.round((sampled / span) * 3_600_000) : 0;

      // Timer utilization
      const expired = this.timerExpired.get(tableId) || 0;
      const acted = this.timerActed.get(tableId) || 0;
      const timerTotal = expired + acted;
      const timerUtilization = timerTotal > 0 ? Math.round((expired / timerTotal) * 100) : 0;

      const playerCount = this.tablePlayers.get(tableId) || 0;
      totalPlayers += playerCount;

      tables.push({
        tableId,
        handsDealt,
        handsPerHour,
        avgHandDurationMs: Math.round(avgTotal),
        avgDealTimeMs: Math.round(avgDealMs),
        avgEvalTimeMs: Math.round(avgEvalMs),
        timerUtilization,
        lastHandAt: timings[timings.length - 1].timestamp,
      });
    }

    const activeTables = tables.length;
    const cacheTotal = this.cacheHits + this.cacheMisses;

    const global: GlobalMetrics = {
      activeTables,
      activePlayers: totalPlayers,
      // Monotonic and independent of the ring buffer, so a table whose window
      // has aged out cannot make a counter go backwards. `totalHands` (the sum
      // over currently-tracked tables) is kept only as the floor.
      totalHandsDealt: Math.max(this.handsRecorded, totalHands),
      avgHandsPerHour:
        activeTables > 0
          ? Math.round(tables.reduce((s, t) => s + t.handsPerHour, 0) / activeTables)
          : 0,
      avgHandDurationMs: activeTables > 0 ? Math.round(totalDuration / activeTables) : 0,
      cacheHitRatio: cacheTotal > 0 ? Math.round((this.cacheHits / cacheTotal) * 100) : 0,
      uptime: Date.now() - this.startedAt,
    };

    return { timestamp: Date.now(), global, tables };
  }

  /**
   * Emit telemetry snapshot via callback.
   */
  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    const perf = this.getPerformanceSummary();
    if (snapshot.global.activeTables > 0 || perf.actionCount > 0) {
      this.emitEvent({
        type: 'ENGINE_TELEMETRY',
        activeTables: snapshot.global.activeTables,
        totalHandsDealt: snapshot.global.totalHandsDealt,
        avgHandsPerHour: snapshot.global.avgHandsPerHour,
        cacheHitRatio: snapshot.global.cacheHitRatio,
        // Bible V8 §9.1 Performance Metrics
        avgActionProcessingMs: perf.avgProcessingMs,
        p95ActionProcessingMs: perf.p95ProcessingMs,
        avgBroadcastMs: perf.avgBroadcastMs,
        p95BroadcastMs: perf.p95BroadcastMs,
        actionProcessingViolations: perf.processingViolations,
        broadcastViolations: perf.broadcastViolations,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bible V8 §10.4: PROMETHEUS METRICS EXPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /metrics — Prometheus text exposition format.
   * Exposes all engine metrics for Grafana dashboards.
   * Standard Prometheus text format: https://prometheus.io/docs/instrumenting/exposition_formats/
   */
  getPrometheusMetrics(): string {
    const snapshot = this.getSnapshot();
    const perf = this.getPerformanceSummary();
    const lines: string[] = [];

    // Global metrics
    lines.push('# HELP poker_active_tables Number of active tables');
    lines.push('# TYPE poker_active_tables gauge');
    lines.push(`poker_active_tables ${snapshot.global.activeTables}`);

    lines.push('# HELP poker_active_players Number of active players');
    lines.push('# TYPE poker_active_players gauge');
    lines.push(`poker_active_players ${snapshot.global.activePlayers}`);

    lines.push('# HELP poker_hands_dealt_total Total hands dealt');
    lines.push('# TYPE poker_hands_dealt_total counter');
    lines.push(`poker_hands_dealt_total ${snapshot.global.totalHandsDealt}`);

    lines.push('# HELP poker_avg_hands_per_hour Average hands per hour');
    lines.push('# TYPE poker_avg_hands_per_hour gauge');
    lines.push(`poker_avg_hands_per_hour ${snapshot.global.avgHandsPerHour}`);

    lines.push('# HELP poker_avg_hand_duration_ms Average hand duration in ms');
    lines.push('# TYPE poker_avg_hand_duration_ms gauge');
    lines.push(`poker_avg_hand_duration_ms ${snapshot.global.avgHandDurationMs}`);

    lines.push('# HELP poker_cache_hit_ratio Cache hit ratio percentage');
    lines.push('# TYPE poker_cache_hit_ratio gauge');
    lines.push(`poker_cache_hit_ratio ${snapshot.global.cacheHitRatio}`);

    lines.push('# HELP poker_uptime_seconds Engine uptime in seconds');
    lines.push('# TYPE poker_uptime_seconds gauge');
    lines.push(`poker_uptime_seconds ${Math.round(snapshot.global.uptime / 1000)}`);

    // Performance metrics (Bible V8 §9.1)
    lines.push('# HELP poker_action_processing_ms Average action processing time');
    lines.push('# TYPE poker_action_processing_ms gauge');
    lines.push(`poker_action_processing_ms ${perf.avgProcessingMs}`);

    lines.push('# HELP poker_action_processing_p95_ms P95 action processing time');
    lines.push('# TYPE poker_action_processing_p95_ms gauge');
    lines.push(`poker_action_processing_p95_ms ${perf.p95ProcessingMs}`);

    lines.push('# HELP poker_broadcast_latency_ms Average broadcast latency');
    lines.push('# TYPE poker_broadcast_latency_ms gauge');
    lines.push(`poker_broadcast_latency_ms ${perf.avgBroadcastMs}`);

    lines.push('# HELP poker_broadcast_latency_p95_ms P95 broadcast latency');
    lines.push('# TYPE poker_broadcast_latency_p95_ms gauge');
    lines.push(`poker_broadcast_latency_p95_ms ${perf.p95BroadcastMs}`);

    lines.push('# HELP poker_threshold_violations_total SLA threshold violations');
    lines.push('# TYPE poker_threshold_violations_total counter');
    lines.push(
      `poker_threshold_violations_total{type="action_processing"} ${perf.processingViolations}`
    );
    lines.push(
      `poker_threshold_violations_total{type="broadcast_latency"} ${perf.broadcastViolations}`
    );

    // Per-table metrics
    lines.push('# HELP poker_table_hands_dealt Hands dealt per table');
    lines.push('# TYPE poker_table_hands_dealt counter');
    lines.push('# HELP poker_table_hands_per_hour Hands per hour per table');
    lines.push('# TYPE poker_table_hands_per_hour gauge');
    lines.push('# HELP poker_table_timer_utilization Timer expiry rate per table');
    lines.push('# TYPE poker_table_timer_utilization gauge');
    lines.push(...this.getPrometheusTableLines());

    return lines.join('\n') + '\n';
  }

  /**
   * ONLY the per-table sample lines — every one carrying a `table_id` label,
   * none of them a global. This is what the fleet renderer concatenates.
   *
   * WHY THIS EXISTS (2026-09-07). `GameServer.getPrometheusMetrics()` used to
   * call `getPrometheusMetrics()` on EVERY table engine and concatenate the
   * results, stripping only the `#` comment lines. Each engine's exposition
   * carries fourteen GLOBAL gauges with no distinguishing label, so a fleet of
   * 272 engines emitted `poker_active_tables`, `poker_hands_dealt_total`,
   * `poker_active_players`, `poker_uptime_seconds` and the rest 272 times
   * each, as 272 samples of the SAME timeseries in one scrape.
   *
   * Prometheus keeps the last of those and drops the other 271. Measured on
   * production 2026-09-07, with 272 tables dealing and the fleet at ~27,000
   * hands an hour, `/api/v1/query` answered:
   *
   *     poker_active_tables      1      (the truth was 272)
   *     poker_active_players     6      (one table's seats)
   *     poker_hands_dealt_total  100    (one table's ring buffer, saturated)
   *
   * Every fleet-level rule written on those names was therefore reading one
   * arbitrary table and calling it the platform:
   *
   *   - `EngineNoHandsDealt` / `EngineHandsStopped` — `increase(...[5m]) == 0`
   *     on a value pinned at 100, so the clause is true forever. It had been
   *     firing continuously for over three hours on a healthy engine.
   *   - `EngineFleetShrank` — `poker_active_tables < 0.5 * avg_over_time(...)`
   *     compares 1 with 1 and can never fire. It is the alarm that should have
   *     caught the 2026-09-07 04:05 UTC collapse, when the fleet lost ~80% of
   *     its throughput for two hours and paged nobody.
   *
   * That is CLAUDE.md 10.83 in its purest form: a check nobody can see is not
   * a check, and an alarm that is always on is an alarm that gets muted.
   * Globals are now aggregated ONCE across the fleet by `renderFleetMetrics`.
   */
  getPrometheusTableLines(): string[] {
    const snapshot = this.getSnapshot();
    const out: string[] = [];
    for (const t of snapshot.tables) {
      out.push(`poker_table_hands_dealt{table_id="${t.tableId}"} ${t.handsDealt}`);
      out.push(`poker_table_hands_per_hour{table_id="${t.tableId}"} ${t.handsPerHour}`);
      out.push(`poker_table_timer_utilization{table_id="${t.tableId}"} ${t.timerUtilization}`);
    }
    return out;
  }

  /**
   * Render the WHOLE fleet's exposition: every global emitted exactly once
   * from an aggregate over all engines, then every per-table line.
   *
   * The aggregation rules are chosen so each name still means what its own
   * HELP text says, fleet-wide:
   *   - counts and totals SUM (tables, players, hands, violations);
   *   - averages are weighted by the tables they average over, so one quiet
   *     table cannot outvote three hundred busy ones;
   *   - p95s take the MAX, because an SLO is breached if ANY table breaches it
   *     (`slo-rules.yml` already wraps these in `max()`, which is a no-op on a
   *     single series and only becomes correct once the series is real);
   *   - uptime takes the MAX — engines are created as tables are adopted, so
   *     the oldest is the one that measures the process.
   */
  /**
   * ── A COUNTER SUMMED OVER A LIVE SET IS NOT A COUNTER (2026-09-07) ────────
   *
   * `renderFleetMetrics` sums each engine's lifetime totals. Engines are
   * created and destroyed constantly as tables open and close, so the SUM
   * drops every time one is retired — and Prometheus reads any drop in a
   * counter as a process restart, adding the whole post-drop value back.
   *
   * MEASURED on production the same day the fleet aggregation shipped, at
   * 15-second resolution over 15 minutes:
   *
   *     61 samples, 11 DROPS
   *       5667 -> 5610   (lost 57)
   *       5689 -> 5624   (lost 65)
   *       5962 -> 5911   (lost 51)
   *
   *     increase(poker_hands_dealt_total[5m])  reported  22,663
   *     hand_history over the same 5 minutes      true     1,260
   *
   * An EIGHTEEN-fold over-count. `EngineHandsStopped` survived it, because it
   * only asks whether the increase is zero and an inflated number is still not
   * zero — but `EngineFleetThroughputCollapsed`, added to catch the 04:05
   * class, divides by table count and compares against 1.0 hands per table per
   * minute. With an 18x numerator it could never fire. The alarm written to
   * close the gap was itself unable to close it.
   *
   * THE FIX IS TO BANK DELTAS, not to sum a shifting set. Recording and disposal
   * bank each engine's increase immediately, and snapshots reconcile the same
   * ledger. Waiting for a scrape loses work when a table retires between reads.
   * Health and Prometheus share this process-wide ledger; neither sums hand
   * ordinals or the live set's ring-buffer lengths. No deletion-site hooks or
   * separate endpoint counters are needed.
   *
   * `activeTables`, `activePlayers` and the averages are GAUGES and are left
   * summed: they are supposed to fall when a table closes.
   */
  private static readonly fleetCounters = {
    hands: 0,
    actions: 0,
    lastHandAt: null as number | null,
    lastActionAt: null as number | null,
    lastActionMonotonicMs: null as number | null,
    lastHandMonotonicMs: null as number | null,
    processingViolations: 0,
    broadcastViolations: 0,
    /** Per-engine last-seen values, so only increases are banked. */
    seen: new WeakMap<
      EngineTelemetry,
      { hands: number; actions: number; proc: number; bcast: number }
    >(),
  };

  /**
   * Bank one engine's increase into the process-wide monotonic totals.
   *
   * Guarded with `> prev` rather than assuming growth: an engine's own count
   * cannot fall today, but a counter that silently absorbs a negative delta is
   * exactly the class of bug this whole note is about.
   */
  private static bankEngineCounters(e: EngineTelemetry): void {
    const f = EngineTelemetry.fleetCounters;
    const prev = f.seen.get(e) ?? { hands: 0, actions: 0, proc: 0, bcast: 0 };
    const hands = Math.max(prev.hands, e.handsRecorded);
    const actions = Math.max(prev.actions, e.actionsRecorded);
    const proc = Math.max(prev.proc, e.actionThresholdViolations);
    const bcast = Math.max(prev.bcast, e.broadcastThresholdViolations);
    f.hands += hands - prev.hands;
    f.actions += actions - prev.actions;
    f.processingViolations += proc - prev.proc;
    f.broadcastViolations += bcast - prev.bcast;
    if (
      e.lastHandRecordedMonotonicMs !== null &&
      (f.lastHandMonotonicMs === null || e.lastHandRecordedMonotonicMs >= f.lastHandMonotonicMs)
    ) {
      f.lastHandAt = e.lastHandRecordedAt;
      f.lastHandMonotonicMs = e.lastHandRecordedMonotonicMs;
    }
    if (
      e.lastActionRecordedMonotonicMs !== null &&
      (f.lastActionMonotonicMs === null ||
        e.lastActionRecordedMonotonicMs >= f.lastActionMonotonicMs)
    ) {
      f.lastActionAt = e.lastActionRecordedAt;
      f.lastActionMonotonicMs = e.lastActionRecordedMonotonicMs;
    }
    f.seen.set(e, { hands, actions, proc, bcast });
  }

  /** Test seam: reset the process-wide banked totals. */
  static __resetFleetCountersForTest(): void {
    EngineTelemetry.fleetCounters.hands = 0;
    EngineTelemetry.fleetCounters.actions = 0;
    EngineTelemetry.fleetCounters.lastHandAt = null;
    EngineTelemetry.fleetCounters.lastActionAt = null;
    EngineTelemetry.fleetCounters.lastActionMonotonicMs = null;
    EngineTelemetry.fleetCounters.lastHandMonotonicMs = null;
    EngineTelemetry.fleetCounters.processingViolations = 0;
    EngineTelemetry.fleetCounters.broadcastViolations = 0;
    EngineTelemetry.fleetCounters.seen = new WeakMap();
  }

  static getFleetSnapshot(engines: Iterable<EngineTelemetry>) {
    let activeTables = 0;
    let activePlayers = 0;
    let handsPerHourWeighted = 0;
    let handDurationWeighted = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let processingWeighted = 0;
    let broadcastWeighted = 0;
    let actionCount = 0;
    let broadcastSampleCount = 0;
    let p95Processing = 0;
    let p95Broadcast = 0;

    for (const e of engines) {
      const s = e.getSnapshot();
      const p = e.getPerformanceSummary();
      activeTables += s.global.activeTables;
      activePlayers += s.global.activePlayers;
      // Counters are BANKED, never summed over the live set — see the note on
      // `fleetCounters`. Summing them made increase() over-report 18x.
      EngineTelemetry.bankEngineCounters(e);
      handsPerHourWeighted += s.global.avgHandsPerHour * s.global.activeTables;
      handDurationWeighted += s.global.avgHandDurationMs * s.global.activeTables;
      cacheHits += e.cacheHits;
      cacheMisses += e.cacheMisses;
      processingWeighted += p.avgProcessingMs * p.actionCount;
      broadcastWeighted += p.avgBroadcastMs * p.broadcastSampleCount;
      actionCount += p.actionCount;
      broadcastSampleCount += p.broadcastSampleCount;
      p95Processing = Math.max(p95Processing, p.p95ProcessingMs);
      p95Broadcast = Math.max(p95Broadcast, p.p95BroadcastMs);
    }

    // Read the BANKED totals, not a sum over whoever happens to be alive.
    const totalHandsDealt = EngineTelemetry.fleetCounters.hands;
    const processingViolations = EngineTelemetry.fleetCounters.processingViolations;
    const broadcastViolations = EngineTelemetry.fleetCounters.broadcastViolations;

    const cacheTotal = cacheHits + cacheMisses;
    const f = EngineTelemetry.fleetCounters;
    return {
      activeTables,
      activePlayers,
      totalHandsDealt,
      avgHandsPerHour: activeTables > 0 ? Math.round(handsPerHourWeighted / activeTables) : null,
      avgHandDurationMs: activeTables > 0 ? Math.round(handDurationWeighted / activeTables) : null,
      cacheHitRatio: cacheTotal > 0 ? Math.round((cacheHits / cacheTotal) * 100) : null,
      avgProcessingMs: actionCount > 0 ? Math.round(processingWeighted / actionCount) : null,
      avgBroadcastMs:
        broadcastSampleCount > 0 ? Math.round(broadcastWeighted / broadcastSampleCount) : null,
      p95Processing: actionCount > 0 ? p95Processing : null,
      p95Broadcast: broadcastSampleCount > 0 ? p95Broadcast : null,
      actionSampleCount: actionCount,
      broadcastSampleCount,
      totalActionsRecorded: f.actions,
      processingViolations,
      broadcastViolations,
      lastHandAt: f.lastHandAt,
      lastActionAt: f.lastActionAt,
      lastHandAgeMs:
        f.lastHandMonotonicMs === null
          ? null
          : Math.max(0, performance.now() - f.lastHandMonotonicMs),
      lastActionAgeMs:
        f.lastActionMonotonicMs === null
          ? null
          : Math.max(0, performance.now() - f.lastActionMonotonicMs),
      actionSampleWindowMs: ACTION_SAMPLE_WINDOW_MS,
    };
  }

  static renderFleetMetrics(engines: Iterable<EngineTelemetry>): string {
    const current = Array.from(engines);
    const fleet = EngineTelemetry.getFleetSnapshot(current);
    const {
      activeTables,
      activePlayers,
      totalHandsDealt,
      processingViolations,
      broadcastViolations,
    } = fleet;
    const tableLines = current.flatMap((e) => e.getPrometheusTableLines());
    const g = (name: string, help: string, type: string, value: number | null): string[] => [
      `# HELP ${name} ${help}`,
      `# TYPE ${name} ${type}`,
      `${name} ${value ?? 'NaN'}`,
    ];

    const lines: string[] = [
      ...g(
        'poker_active_tables',
        'Number of active tables across the fleet',
        'gauge',
        activeTables
      ),
      ...g(
        'poker_active_players',
        'Number of active players across the fleet',
        'gauge',
        activePlayers
      ),
      ...g(
        'poker_hands_dealt_total',
        'Total hands dealt across the fleet since engine start',
        'counter',
        totalHandsDealt
      ),
      ...g(
        'poker_avg_hands_per_hour',
        'Hands per hour, averaged over active tables',
        'gauge',
        fleet.avgHandsPerHour
      ),
      ...g(
        'poker_avg_hand_duration_ms',
        'Hand duration in ms, averaged over active tables',
        'gauge',
        fleet.avgHandDurationMs
      ),
      ...g(
        'poker_cache_hit_ratio',
        'Evaluator cache hit ratio percentage across the fleet',
        'gauge',
        fleet.cacheHitRatio
      ),
      ...g(
        'poker_uptime_seconds',
        'Engine process uptime in seconds',
        'gauge',
        /**
         * THE PROCESS, not the oldest surviving table engine (2026-09-07).
         *
         * `EngineRestartLoop` in engine-freeze-rules.yml alerts on
         * `resets(poker_uptime_seconds[30m]) > 3`, so this value falling means
         * "the engine restarted". `Math.max` over per-engine ages says that
         * whenever the OLDEST engine is retired — a table closing, not a
         * restart. It holds today only because the first engine happens to
         * outlive the others (measured: 0 resets in 30 minutes), which is luck,
         * not a property. `process.uptime()` is the thing the metric claims to
         * be and cannot fall without an actual restart.
         */
        Math.round(process.uptime())
      ),
      ...g(
        'poker_action_processing_ms',
        'Average action processing time across the fleet',
        'gauge',
        fleet.avgProcessingMs
      ),
      ...g(
        'poker_action_processing_p95_ms',
        'Worst per-table P95 action processing time',
        'gauge',
        fleet.p95Processing
      ),
      ...g(
        'poker_broadcast_latency_ms',
        'Average broadcast latency across the fleet',
        'gauge',
        fleet.avgBroadcastMs
      ),
      ...g(
        'poker_broadcast_latency_p95_ms',
        'Worst per-table P95 broadcast latency',
        'gauge',
        fleet.p95Broadcast
      ),
      ...g(
        'poker_actions_recorded_total',
        'Accepted actions recorded since process start',
        'counter',
        fleet.totalActionsRecorded
      ),
      ...g(
        'poker_action_processing_samples',
        'Live-engine action samples in the last five minutes (at most 500 per engine)',
        'gauge',
        fleet.actionSampleCount
      ),
      ...g(
        'poker_broadcast_latency_samples',
        'Measured broadcast latency samples in the action window',
        'gauge',
        fleet.broadcastSampleCount
      ),
      ...g(
        'poker_last_action_sample_age_ms',
        'Age of the last accepted action sample; NaN when none',
        'gauge',
        fleet.lastActionAgeMs
      ),
      '# HELP poker_threshold_violations_total SLA threshold violations',
      '# TYPE poker_threshold_violations_total counter',
      `poker_threshold_violations_total{type="action_processing"} ${processingViolations}`,
      `poker_threshold_violations_total{type="broadcast_latency"} ${broadcastViolations}`,
      '# HELP poker_table_hands_dealt Hands dealt per table',
      '# TYPE poker_table_hands_dealt counter',
      '# HELP poker_table_hands_per_hour Hands per hour per table',
      '# TYPE poker_table_hands_per_hour gauge',
      '# HELP poker_table_timer_utilization Timer expiry rate per table',
      '# TYPE poker_table_timer_utilization gauge',
      ...tableLines,
    ];

    return lines.join('\n') + '\n';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(): void {
    EngineTelemetry.bankEngineCounters(this);
    if (this.emitInterval) {
      clearInterval(this.emitInterval);
      this.emitInterval = null;
    }
    this.tableTimings.clear();
    this.tablePlayers.clear();
    this.timerExpired.clear();
    this.timerActed.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.actionTimings = [];
    this.actionThresholdViolations = 0;
    this.broadcastThresholdViolations = 0;
  }

  private emitEvent(event: TelemetryEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'EngineTelemetry.eventHandler');
      }
    }
  }
}
