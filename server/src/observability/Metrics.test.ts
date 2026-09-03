import { describe, it, expect } from 'vitest';
import {
  percentile,
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  InMemoryMetricsExporter,
  EventLoopLagMonitor,
  createDefaultRegistry,
} from './Metrics.js';

describe('percentile (nearest-rank)', () => {
  it('returns 0 for empty input', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('computes p50/p95/p99 on 1..100', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.95)).toBe(95);
    expect(percentile(v, 0.99)).toBe(99);
  });

  it('handles unsorted input', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
  });

  it('clamps q<=0 to min and q>=1 to max', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 1)).toBe(30);
    expect(percentile([10, 20, 30], 2)).toBe(30);
  });

  it('single element returns that element for any q', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });
});

describe('Counter', () => {
  it('increments and reads by label set', () => {
    const c = new Counter('reqs');
    c.inc();
    c.inc(2, { method: 'act' });
    c.inc(1, { method: 'act' });
    expect(c.get()).toBe(1);
    expect(c.get({ method: 'act' })).toBe(3);
  });

  it('rejects negative increments', () => {
    const c = new Counter('reqs');
    expect(() => c.inc(-1)).toThrow();
  });
});

describe('Gauge', () => {
  it('set/inc/dec', () => {
    const g = new Gauge('tables');
    g.set(5);
    g.inc();
    g.dec(2);
    expect(g.get()).toBe(4);
  });
});

describe('Histogram', () => {
  it('tracks count/sum/min/max/mean and percentiles', () => {
    const h = new Histogram('lat', 'latency', [10, 50, 100]);
    for (const v of [5, 15, 25, 75, 200]) h.observe(v);
    const s = h.snapshot()[0];
    expect(s.count).toBe(5);
    expect(s.sum).toBe(320);
    expect(s.min).toBe(5);
    expect(s.max).toBe(200);
    expect(s.mean).toBeCloseTo(64);
    // buckets are cumulative (value <= le)
    const b10 = s.buckets.find((b) => b.le === 10)!;
    const b50 = s.buckets.find((b) => b.le === 50)!;
    const b100 = s.buckets.find((b) => b.le === 100)!;
    expect(b10.count).toBe(1); // {5}
    expect(b50.count).toBe(3); // {5,15,25}
    expect(b100.count).toBe(4); // {5,15,25,75}
  });

  it('rejects non-ascending buckets', () => {
    expect(() => new Histogram('bad', '', [10, 5])).toThrow();
  });

  it('startTimer observes elapsed with injectable clock', () => {
    let now = 1000;
    const h = new Histogram('t');
    const stop = h.startTimer({}, () => now);
    now = 1042;
    const elapsed = stop();
    expect(elapsed).toBe(42);
    expect(h.snapshot()[0].count).toBe(1);
    expect(h.snapshot()[0].sum).toBe(42);
  });
});

describe('MetricsRegistry prometheus render', () => {
  it('renders counters, gauges and histogram buckets with +Inf', () => {
    const r = new MetricsRegistry();
    r.counter('hands_total', 'total hands').inc(3, { table: 't1' });
    r.gauge('active_tables').set(2);
    const h = r.histogram('lat_ms', 'latency', [10, 100]);
    h.observe(5);
    h.observe(50);
    const text = r.renderPrometheus();
    expect(text).toContain('# TYPE hands_total counter');
    expect(text).toContain('hands_total{table="t1"} 3');
    expect(text).toContain('active_tables 2');
    expect(text).toContain('lat_ms_bucket{le="10"} 1');
    expect(text).toContain('lat_ms_bucket{le="100"} 2');
    expect(text).toContain('lat_ms_bucket{le="+Inf"} 2');
    expect(text).toContain('lat_ms_count 2');
    expect(text).toContain('lat_ms_sum 55');
  });

  it('exports a snapshot to an OTel-compatible exporter seam', async () => {
    const r = new MetricsRegistry();
    r.counter('c').inc(7);
    const exporter = new InMemoryMetricsExporter();
    await r.exportTo(exporter, () => 12345);
    expect(exporter.last!.timestamp).toBe(12345);
    expect(exporter.last!.counters[0].value).toBe(7);
  });
});

describe('EventLoopLagMonitor', () => {
  it('records lag from clock drift with injected timer', () => {
    let now = 0;
    let cb: (() => void) | null = null;
    const h = new Histogram('loop_lag', '', [1, 5, 10, 100]);
    const mon = new EventLoopLagMonitor(h, {
      intervalMs: 1000,
      now: () => now,
      setIntervalFn: (fn) => {
        cb = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {
        cb = null;
      },
    });
    mon.start();
    // expected next fire at 1000; simulate firing late at 1030 -> lag 30
    now = 1030;
    const lag = mon.tick();
    expect(lag).toBe(30);
    // on-time next fire: expectedNext reset to 1030+1000=2030, fire at 2030 -> lag 0
    now = 2030;
    expect(mon.tick()).toBe(0);
    expect(cb).not.toBeNull();
    mon.stop();
    expect(h.snapshot()[0].count).toBe(2);
  });
});

describe('createDefaultRegistry', () => {
  it('wires the named high-value metrics', () => {
    const d = createDefaultRegistry();
    d.handsTotal.inc(1, { table_id: 't1' });
    d.actToBroadcastLatency.observe(12);
    d.rpcErrorsTotal.inc();
    const text = d.registry.renderPrometheus();
    expect(text).toContain('poker_hands_total');
    expect(text).toContain('poker_act_to_broadcast_latency_ms');
    expect(text).toContain('poker_rpc_errors_total');
    expect(text).toContain('poker_event_loop_lag_ms');
  });
});
