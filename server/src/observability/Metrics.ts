/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  METRICS — Lightweight Metrics Registry (Counters / Gauges / Histograms)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FOUNDATION MODULE — self-contained, no engine dependencies.
 * NOT yet wired into the live engine. See INSTRUMENTATION POINTS below for the
 * ~6 highest-value call sites to wire in follow-up work.
 *
 * Complements the existing `engine/EngineTelemetry.ts` (which tracks per-table
 * hand/eval timings + a Prometheus dump). This registry is the general-purpose
 * primitive layer: arbitrary named counters/gauges/histograms with label sets,
 * exact percentile math, a Prometheus text exporter for `/metrics`, and an
 * OpenTelemetry-compatible exporter SEAM (`MetricsExporter`).
 *
 * Design goals:
 *   - Zero external deps (works in the container + on device today).
 *   - Deterministic, unit-testable percentile math (nearest-rank).
 *   - Injectable clock so tests never touch wall time.
 *
 * ── INSTRUMENTATION POINTS (wire these in a follow-up; do NOT edit engine here) ──
 *   1. ServerTableEngine.processAction()      → hands/actions counters + act latency timer start
 *   2. ServerTableEngine.broadcastState()     → observe act→broadcast latency histogram
 *   3. HandController.completeHand()           → poker_hands_total counter + hand duration
 *   4. router.ts / handlers.* RPC dispatch     → rpc_total + rpc_errors_total counters
 *   5. transport/EngineWebSocketServer (onclose/reconnect) → ws_reconnects_total counter
 *   6. index.ts bootstrap                      → EventLoopLagMonitor.start() (event-loop lag)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type LabelValues = Record<string, string>;

export interface MetricSampleSnapshot {
  name: string;
  labels: LabelValues;
  value: number;
}

export interface HistogramSnapshot {
  name: string;
  labels: LabelValues;
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  buckets: { le: number; count: number }[];
}

export interface MetricsSnapshot {
  timestamp: number;
  counters: MetricSampleSnapshot[];
  gauges: MetricSampleSnapshot[];
  histograms: HistogramSnapshot[];
}

/**
 * OpenTelemetry-compatible export SEAM. Implement this to bridge into an OTel
 * MeterProvider / OTLP exporter. `InMemoryMetricsExporter` is provided for tests
 * and `renderPrometheus()` on the registry covers the pull-based `/metrics` path.
 */
export interface MetricsExporter {
  export(snapshot: MetricsSnapshot): void | Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Percentile math (nearest-rank) — exported for direct unit testing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nearest-rank percentile. `q` in [0,1]. Returns 0 for an empty input.
 * `values` need not be pre-sorted. q<=0 returns the minimum.
 */
export function percentile(values: number[], q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[n - 1];
  const rank = Math.ceil(q * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sorted[idx];
}

function labelKey(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function renderLabels(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const inner = keys
    .map(
      (k) =>
        `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
    )
    .join(',');
  return `{${inner}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Counter
// ─────────────────────────────────────────────────────────────────────────────

export class Counter {
  private series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(
    public readonly name: string,
    public readonly help: string = ''
  ) {}

  inc(amount = 1, labels: LabelValues = {}): void {
    if (amount < 0)
      throw new Error(`Counter ${this.name} cannot be incremented by a negative value`);
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) existing.value += amount;
    else this.series.set(key, { labels, value: amount });
  }

  get(labels: LabelValues = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  snapshot(): MetricSampleSnapshot[] {
    return [...this.series.values()].map((s) => ({
      name: this.name,
      labels: s.labels,
      value: s.value,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gauge
// ─────────────────────────────────────────────────────────────────────────────

export class Gauge {
  private series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(
    public readonly name: string,
    public readonly help: string = ''
  ) {}

  set(value: number, labels: LabelValues = {}): void {
    this.series.set(labelKey(labels), { labels, value });
  }

  inc(amount = 1, labels: LabelValues = {}): void {
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) existing.value += amount;
    else this.series.set(key, { labels, value: amount });
  }

  dec(amount = 1, labels: LabelValues = {}): void {
    this.inc(-amount, labels);
  }

  get(labels: LabelValues = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  snapshot(): MetricSampleSnapshot[] {
    return [...this.series.values()].map((s) => ({
      name: this.name,
      labels: s.labels,
      value: s.value,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Histogram
// ─────────────────────────────────────────────────────────────────────────────

/** Default latency buckets (ms) suitable for act→broadcast + RPC timings. */
export const DEFAULT_LATENCY_BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

interface HistSeries {
  labels: LabelValues;
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketCounts: number[]; // parallel to buckets
  samples: number[]; // bounded ring for exact percentiles
}

export class Histogram {
  private series = new Map<string, HistSeries>();

  constructor(
    public readonly name: string,
    public readonly help: string = '',
    public readonly buckets: number[] = DEFAULT_LATENCY_BUCKETS_MS,
    private readonly maxSamples = 4096
  ) {
    // Buckets must be ascending for the +Inf cumulative render to be correct.
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i] <= buckets[i - 1]) {
        throw new Error(`Histogram ${name}: buckets must be strictly ascending`);
      }
    }
  }

  observe(value: number, labels: LabelValues = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = {
        labels,
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        bucketCounts: new Array(this.buckets.length).fill(0),
        samples: [],
      };
      this.series.set(key, s);
    }
    s.count++;
    s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.bucketCounts[i]++;
    }
    if (s.samples.length >= this.maxSamples) s.samples.shift();
    s.samples.push(value);
  }

  /** Start a timer; call the returned fn to observe elapsed ms. Uses injectable now(). */
  startTimer(labels: LabelValues = {}, now: () => number = () => Date.now()): () => number {
    const start = now();
    return () => {
      const elapsed = now() - start;
      this.observe(elapsed, labels);
      return elapsed;
    };
  }

  snapshot(): HistogramSnapshot[] {
    return [...this.series.values()].map((s) => ({
      name: this.name,
      labels: s.labels,
      count: s.count,
      sum: s.sum,
      min: s.count > 0 ? s.min : 0,
      max: s.count > 0 ? s.max : 0,
      mean: s.count > 0 ? s.sum / s.count : 0,
      p50: percentile(s.samples, 0.5),
      p90: percentile(s.samples, 0.9),
      p95: percentile(s.samples, 0.95),
      p99: percentile(s.samples, 0.99),
      buckets: this.buckets.map((le, i) => ({ le, count: s.bucketCounts[i] })),
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  counter(name: string, help = ''): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, help = ''): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help);
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, help = '', buckets: number[] = DEFAULT_LATENCY_BUCKETS_MS): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help, buckets);
      this.histograms.set(name, h);
    }
    return h;
  }

  snapshot(now: () => number = () => Date.now()): MetricsSnapshot {
    const counters: MetricSampleSnapshot[] = [];
    const gauges: MetricSampleSnapshot[] = [];
    const histograms: HistogramSnapshot[] = [];
    for (const c of this.counters.values()) counters.push(...c.snapshot());
    for (const g of this.gauges.values()) gauges.push(...g.snapshot());
    for (const h of this.histograms.values()) histograms.push(...h.snapshot());
    return { timestamp: now(), counters, gauges, histograms };
  }

  /** Prometheus text exposition format — serve from `/metrics`. */
  renderPrometheus(): string {
    const lines: string[] = [];
    for (const c of this.counters.values()) {
      if (c.help) lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`);
      const samples = c.snapshot();
      if (samples.length === 0) lines.push(`${c.name} 0`);
      for (const s of samples) lines.push(`${c.name}${renderLabels(s.labels)} ${s.value}`);
    }
    for (const g of this.gauges.values()) {
      if (g.help) lines.push(`# HELP ${g.name} ${g.help}`);
      lines.push(`# TYPE ${g.name} gauge`);
      for (const s of g.snapshot()) lines.push(`${g.name}${renderLabels(s.labels)} ${s.value}`);
    }
    for (const h of this.histograms.values()) {
      if (h.help) lines.push(`# HELP ${h.name} ${h.help}`);
      lines.push(`# TYPE ${h.name} histogram`);
      for (const s of h.snapshot()) {
        let cumulative = 0;
        for (const b of s.buckets) {
          cumulative = b.count; // bucketCounts are already cumulative (value <= le)
          const leLabels = { ...s.labels, le: String(b.le) };
          lines.push(`${h.name}_bucket${renderLabels(leLabels)} ${cumulative}`);
        }
        const infLabels = { ...s.labels, le: '+Inf' };
        lines.push(`${h.name}_bucket${renderLabels(infLabels)} ${s.count}`);
        lines.push(`${h.name}_sum${renderLabels(s.labels)} ${s.sum}`);
        lines.push(`${h.name}_count${renderLabels(s.labels)} ${s.count}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /** Push the current snapshot to an OTel-compatible exporter (SEAM). */
  async exportTo(exporter: MetricsExporter, now: () => number = () => Date.now()): Promise<void> {
    await exporter.export(this.snapshot(now));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exporters
// ─────────────────────────────────────────────────────────────────────────────

/** Test/dev exporter that retains the last N snapshots in memory. */
export class InMemoryMetricsExporter implements MetricsExporter {
  readonly snapshots: MetricsSnapshot[] = [];
  constructor(private readonly max = 100) {}
  export(snapshot: MetricsSnapshot): void {
    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.max) this.snapshots.shift();
  }
  get last(): MetricsSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event-loop lag monitor (populates a histogram) — highest-value node health signal
// ─────────────────────────────────────────────────────────────────────────────

export interface EventLoopLagOptions {
  intervalMs?: number;
  now?: () => number;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Measures event-loop lag: the delta between the expected fire time of a fixed
 * interval and its actual fire time. Records ms lag into the provided histogram.
 * Timer + clock are injectable so this is fully unit-testable without real time.
 */
export class EventLoopLagMonitor {
  private handle: ReturnType<typeof setInterval> | null = null;
  private expectedNext = 0;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  constructor(
    private readonly histogram: Histogram,
    opts: EventLoopLagOptions = {}
  ) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
  }

  start(): void {
    if (this.handle) return;
    this.expectedNext = this.now() + this.intervalMs;
    this.handle = this.setIntervalFn(() => this.tick(), this.intervalMs);
    if (typeof (this.handle as unknown as { unref?: () => void })?.unref === 'function') {
      (this.handle as unknown as { unref: () => void }).unref();
    }
  }

  /** Exposed for tests — normally driven by the interval. */
  tick(): number {
    const actual = this.now();
    const lag = Math.max(0, actual - this.expectedNext);
    this.histogram.observe(lag);
    this.expectedNext = actual + this.intervalMs;
    return lag;
  }

  stop(): void {
    if (this.handle) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default registry + the named metrics called out in the instrumentation points
// ─────────────────────────────────────────────────────────────────────────────

export function createDefaultRegistry(): {
  registry: MetricsRegistry;
  handsTotal: Counter;
  actToBroadcastLatency: Histogram;
  handDuration: Histogram;
  rpcTotal: Counter;
  rpcErrorsTotal: Counter;
  wsReconnectsTotal: Counter;
  eventLoopLag: Histogram;
} {
  const registry = new MetricsRegistry();
  return {
    registry,
    handsTotal: registry.counter(
      'poker_hands_total',
      'Total hands played (label: table_id, variant)'
    ),
    actToBroadcastLatency: registry.histogram(
      'poker_act_to_broadcast_latency_ms',
      'Latency from action accepted to state broadcast (ms)'
    ),
    handDuration: registry.histogram(
      'poker_hand_duration_ms',
      'Wall-clock hand duration (ms)',
      [500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000]
    ),
    rpcTotal: registry.counter(
      'poker_rpc_total',
      'Total RPC/HTTP+WS requests dispatched (label: method)'
    ),
    rpcErrorsTotal: registry.counter(
      'poker_rpc_errors_total',
      'Total RPC/HTTP+WS requests that errored (label: method)'
    ),
    wsReconnectsTotal: registry.counter(
      'poker_ws_reconnects_total',
      'Total WebSocket reconnects observed'
    ),
    eventLoopLag: registry.histogram(
      'poker_event_loop_lag_ms',
      'Event-loop lag (ms)',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000]
    ),
  };
}
