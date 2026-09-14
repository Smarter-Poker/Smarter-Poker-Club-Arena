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
  // Monotonic hand counts. NOT derived from tableTimings, which is a capped
  // ring buffer — see the note in recordHandTiming().
  private handsRecorded: number = 0;
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
    this.handsRecordedByTable.set(tableId, (this.handsRecordedByTable.get(tableId) || 0) + 1);
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
   * THE FIX IS TO BANK DELTAS, not to sum a shifting set. Each scrape, every
   * engine's own lifetime count is compared with what it last reported; only
   * the INCREASE is added to a process-wide total. An engine that disappears
   * simply stops contributing — everything it dealt is already banked — so the
   * fleet total is monotonic for the life of the process by construction, and
   * needs no hook at any of the seven `tableEngines.delete()` sites.
   *
   * `activeTables`, `activePlayers` and the averages are GAUGES and are left
   * summed: they are supposed to fall when a table closes.
   */
  private static readonly fleetCounters = {
    hands: 0,
    processingViolations: 0,
    broadcastViolations: 0,
    /** Per-engine last-seen values, so only increases are banked. */
    seen: new WeakMap<EngineTelemetry, { hands: number; proc: number; bcast: number }>(),
  };

  /**
   * Bank one engine's increase into the process-wide monotonic totals.
   *
   * Guarded with `> prev` rather than assuming growth: an engine's own count
   * cannot fall today, but a counter that silently absorbs a negative delta is
   * exactly the class of bug this whole note is about.
   */
  private static bankEngineCounters(
    e: EngineTelemetry,
    hands: number,
    proc: number,
    bcast: number
  ): void {
    const f = EngineTelemetry.fleetCounters;
    const prev = f.seen.get(e) ?? { hands: 0, proc: 0, bcast: 0 };
    if (hands > prev.hands) f.hands += hands - prev.hands;
    if (proc > prev.proc) f.processingViolations += proc - prev.proc;
    if (bcast > prev.bcast) f.broadcastViolations += bcast - prev.bcast;
    f.seen.set(e, { hands, proc, bcast });
  }

  /** Test seam: reset the process-wide banked totals. */
  static __resetFleetCountersForTest(): void {
    EngineTelemetry.fleetCounters.hands = 0;
    EngineTelemetry.fleetCounters.processingViolations = 0;
    EngineTelemetry.fleetCounters.broadcastViolations = 0;
    EngineTelemetry.fleetCounters.seen = new WeakMap();
  }

  /**
   * How many tables keep a per-table sample per metric name.
   *
   * Twenty answers "which table is hot" for a human and costs sixty samples
   * instead of two and a half thousand. A fleet smaller than this is emitted
   * whole, so nothing changes for a small process or for a test fixture.
   */
  private static readonly PER_TABLE_SAMPLE_CAP = 20;

  static renderFleetMetrics(engines: Iterable<EngineTelemetry>): string {
    let activeTables = 0;
    let activePlayers = 0;
    let handsPerHourWeighted = 0;
    let handDurationWeighted = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let processingWeighted = 0;
    let broadcastWeighted = 0;
    let actionCount = 0;
    let p95Processing = 0;
    let p95Broadcast = 0;
    const tableLines: string[] = [];

    for (const e of engines) {
      const s = e.getSnapshot();
      const p = e.getPerformanceSummary();
      activeTables += s.global.activeTables;
      activePlayers += s.global.activePlayers;
      // Counters are BANKED, never summed over the live set — see the note on
      // `fleetCounters`. Summing them made increase() over-report 18x.
      EngineTelemetry.bankEngineCounters(
        e,
        s.global.totalHandsDealt,
        p.processingViolations,
        p.broadcastViolations
      );
      handsPerHourWeighted += s.global.avgHandsPerHour * s.global.activeTables;
      handDurationWeighted += s.global.avgHandDurationMs * s.global.activeTables;
      cacheHits += e.cacheHits;
      cacheMisses += e.cacheMisses;
      processingWeighted += p.avgProcessingMs * p.actionCount;
      broadcastWeighted += p.avgBroadcastMs * p.actionCount;
      actionCount += p.actionCount;
      p95Processing = Math.max(p95Processing, p.p95ProcessingMs);
      p95Broadcast = Math.max(p95Broadcast, p.p95BroadcastMs);
      tableLines.push(...e.getPrometheusTableLines());
    }

    /* ── A SCRAPE IS NOT A STALL (2026-09-11) ────────────────────────────────
     *
     * These three per-table gauges are emitted for EVERY table the process
     * owns, and `/metrics` is rendered on the AUTHORITATIVE EVENT LOOP. At 804
     * dealing tables that is 2,412 samples of the 7,005 in one exposition;
     * the whole body was 590 KB and took 136-502 ms to build, every fifteen
     * seconds, on the single thread that also runs every turn timer, every
     * broadcast and every horse decision round trip. Measured on engine-01 the
     * same evening, with the main loop already at 309 ms p50.
     *
     * Nothing reads them per table. Not one alert rule in infra/monitoring and
     * not one recording rule names `poker_table_hands_dealt`,
     * `poker_table_hands_per_hour` or `poker_table_timer_utilization`; the
     * fleet questions are answered by `poker_hands_dealt_total`,
     * `poker_active_tables` and the aggregates below, which are always
     * present and correct.
     *
     * So: the BUSIEST tables keep their per-table line, because "which table
     * is hot" is a real question an operator asks and the answer is useless if
     * it is a thousand rows. Everything else is summarised. The cut is by
     * hands dealt, so a table that is doing anything at all is the one that
     * survives, and a fleet smaller than the cap is emitted whole - which is
     * also why `oneSeriesPerMetricName.law.test.ts` still sees every fixture
     * table it asserts on.
     */
    const perTableCap = EngineTelemetry.PER_TABLE_SAMPLE_CAP;
    const byName = new Map<string, string[]>();
    for (const line of tableLines) {
      const name = line.slice(0, line.indexOf('{'));
      const list = byName.get(name);
      if (list) list.push(line);
      else byName.set(name, [line]);
    }
    const keptTableLines: string[] = [];
    for (const [, list] of byName) {
      if (list.length <= perTableCap) {
        keptTableLines.push(...list);
        continue;
      }
      const valueOf = (line: string): number => Number(line.slice(line.lastIndexOf('} ') + 2)) || 0;
      keptTableLines.push(
        ...[...list].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, perTableCap)
      );
    }
    const tableSampleCount = tableLines.length;
    tableLines.length = 0;
    tableLines.push(...keptTableLines);

    // Read the BANKED totals, not a sum over whoever happens to be alive.
    const totalHandsDealt = EngineTelemetry.fleetCounters.hands;
    const processingViolations = EngineTelemetry.fleetCounters.processingViolations;
    const broadcastViolations = EngineTelemetry.fleetCounters.broadcastViolations;

    const cacheTotal = cacheHits + cacheMisses;
    const g = (name: string, help: string, type: string, value: number): string[] => [
      `# HELP ${name} ${help}`,
      `# TYPE ${name} ${type}`,
      `${name} ${value}`,
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
        activeTables > 0 ? Math.round(handsPerHourWeighted / activeTables) : 0
      ),
      ...g(
        'poker_avg_hand_duration_ms',
        'Hand duration in ms, averaged over active tables',
        'gauge',
        activeTables > 0 ? Math.round(handDurationWeighted / activeTables) : 0
      ),
      ...g(
        'poker_cache_hit_ratio',
        'Evaluator cache hit ratio percentage across the fleet',
        'gauge',
        cacheTotal > 0 ? Math.round((cacheHits / cacheTotal) * 100) : 0
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
        actionCount > 0 ? Math.round(processingWeighted / actionCount) : 0
      ),
      ...g(
        'poker_action_processing_p95_ms',
        'Worst per-table P95 action processing time',
        'gauge',
        p95Processing
      ),
      ...g(
        'poker_broadcast_latency_ms',
        'Average broadcast latency across the fleet',
        'gauge',
        actionCount > 0 ? Math.round(broadcastWeighted / actionCount) : 0
      ),
      ...g(
        'poker_broadcast_latency_p95_ms',
        'Worst per-table P95 broadcast latency',
        'gauge',
        p95Broadcast
      ),
      '# HELP poker_threshold_violations_total SLA threshold violations',
      '# TYPE poker_threshold_violations_total counter',
      `poker_threshold_violations_total{type="action_processing"} ${processingViolations}`,
      `poker_threshold_violations_total{type="broadcast_latency"} ${broadcastViolations}`,
      '# HELP poker_table_hands_dealt Hands dealt per table (busiest tables only, see poker_fleet_per_table_samples_total)',
      '# TYPE poker_table_hands_dealt counter',
      '# HELP poker_table_hands_per_hour Hands per hour per table (busiest tables only)',
      '# TYPE poker_table_hands_per_hour gauge',
      '# HELP poker_table_timer_utilization Timer expiry rate per table (busiest tables only)',
      '# TYPE poker_table_timer_utilization gauge',
      /* THE TRUNCATION IS NEVER SILENT (CLAUDE.md 10.86). These two say how
         many per-table samples the fleet had and how many this exposition
         carries, so "my table is not in the scrape" has an answer that is a
         number rather than a mystery. */
      '# HELP poker_fleet_per_table_samples_total Per-table samples the fleet would emit uncapped',
      '# TYPE poker_fleet_per_table_samples_total gauge',
      `poker_fleet_per_table_samples_total ${tableSampleCount}`,
      '# HELP poker_fleet_per_table_samples_emitted Per-table samples this exposition carries',
      '# TYPE poker_fleet_per_table_samples_emitted gauge',
      `poker_fleet_per_table_samples_emitted ${tableLines.length}`,
      ...tableLines,
    ];

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
