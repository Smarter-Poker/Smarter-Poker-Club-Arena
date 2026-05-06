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
const BROADCAST_LATENCY_THRESHOLD_MS = 100; // §9.1.2: < 100ms to all clients

interface ActionTiming {
  tableId: string;
  userId: string;
  action: string;
  processingMs: number;
  broadcastMs: number | null; // null if not measured
  timestamp: number;
  exceededThreshold: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE TELEMETRY CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class EngineTelemetry {
  private startedAt: number = Date.now();
  // Per-table hand durations (keep last 100 per table)
  private tableTimings: Map<string, HandTiming[]> = new Map();
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
  recordActionProcessingTime(
    tableId: string,
    userId: string,
    action: string,
    processingMs: number,
    broadcastMs: number | null = null
  ): void {
    const exceeded =
      processingMs > ACTION_PROCESSING_THRESHOLD_MS ||
      (broadcastMs !== null && broadcastMs > BROADCAST_LATENCY_THRESHOLD_MS);

    if (exceeded) {
      this.actionThresholdViolations++;
      // Log warning for threshold violations
      const parts = [`§9.1 PERF WARNING: ${action} on ${tableId}`];
      if (processingMs > ACTION_PROCESSING_THRESHOLD_MS) {
        parts.push(`processing=${processingMs}ms (>${ACTION_PROCESSING_THRESHOLD_MS}ms)`);
      }
      if (broadcastMs !== null && broadcastMs > BROADCAST_LATENCY_THRESHOLD_MS) {
        parts.push(`broadcast=${broadcastMs}ms (>${BROADCAST_LATENCY_THRESHOLD_MS}ms)`);
        this.broadcastThresholdViolations++;
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
  } {
    const timings = this.actionTimings;
    if (timings.length === 0) {
      return {
        avgProcessingMs: 0,
        avgBroadcastMs: 0,
        p95ProcessingMs: 0,
        p95BroadcastMs: 0,
        actionCount: 0,
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

      const handsDealt = timings.length;
      totalHands += handsDealt;

      // Avg timings
      const avgDealMs = timings.reduce((s, t) => s + t.dealMs, 0) / handsDealt;
      const avgEvalMs = timings.reduce((s, t) => s + t.evalMs, 0) / handsDealt;
      const avgTotal = timings.reduce((s, t) => s + t.totalMs, 0) / handsDealt;
      totalDuration += avgTotal;

      // Hands per hour (based on first and last timing)
      const span = timings[timings.length - 1].timestamp - timings[0].timestamp;
      const handsPerHour = span > 0 ? Math.round((handsDealt / span) * 3_600_000) : 0;

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
      totalHandsDealt: totalHands,
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
    for (const t of snapshot.tables) {
      lines.push(`poker_table_hands_dealt{table_id="${t.tableId}"} ${t.handsDealt}`);
    }

    lines.push('# HELP poker_table_hands_per_hour Hands per hour per table');
    lines.push('# TYPE poker_table_hands_per_hour gauge');
    for (const t of snapshot.tables) {
      lines.push(`poker_table_hands_per_hour{table_id="${t.tableId}"} ${t.handsPerHour}`);
    }

    lines.push('# HELP poker_table_timer_utilization Timer expiry rate per table');
    lines.push('# TYPE poker_table_timer_utilization gauge');
    for (const t of snapshot.tables) {
      lines.push(`poker_table_timer_utilization{table_id="${t.tableId}"} ${t.timerUtilization}`);
    }

    return lines.join('\n') + '\n';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(): void {
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
