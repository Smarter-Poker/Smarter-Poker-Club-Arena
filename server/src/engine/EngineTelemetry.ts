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
    if (snapshot.global.activeTables > 0) {
      this.emitEvent({
        type: 'ENGINE_TELEMETRY',
        activeTables: snapshot.global.activeTables,
        totalHandsDealt: snapshot.global.totalHandsDealt,
        avgHandsPerHour: snapshot.global.avgHandsPerHour,
        cacheHitRatio: snapshot.global.cacheHitRatio,
      });
    }
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
  }

  private emitEvent(event: TelemetryEvent): void {
    if (this.onEvent) {
      try { this.onEvent(event); } catch (err) { console.error('[EngineTelemetry] Event handler error:', err); }
    }
  }
}
