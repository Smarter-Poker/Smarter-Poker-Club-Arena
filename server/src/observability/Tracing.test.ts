import { describe, it, expect } from 'vitest';
import {
  Tracer,
  InMemorySpanExporter,
  startHandSpan,
  startActionSpan,
  startRpcSpan,
} from './Tracing.js';
import { Histogram } from './Metrics.js';

function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('Tracer span timing', () => {
  it('records duration with injectable clock', () => {
    const clk = fakeClock(1000);
    const exporter = new InMemorySpanExporter();
    const tracer = new Tracer({ now: clk.now, exporter });
    const span = tracer.startSpan('op');
    clk.advance(25);
    const dur = span.end();
    expect(dur).toBe(25);
    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0].durationMs).toBe(25);
    expect(exporter.spans[0].status.code).toBe('ok');
  });

  it('parent/child share a trace id and link', () => {
    const clk = fakeClock();
    const tracer = new Tracer({ now: clk.now });
    const parent = startHandSpan(tracer, { tableId: 't1', handNumber: 5, variant: 'nlhe' });
    const child = startActionSpan(tracer, {
      tableId: 't1',
      userId: 'u1',
      action: 'raise',
      parent,
    });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(parent.attributes['poker.hand_number']).toBe(5);
    expect(child.attributes['poker.action']).toBe('raise');
  });

  it('records exceptions and sets error status', () => {
    const clk = fakeClock();
    const exporter = new InMemorySpanExporter();
    const tracer = new Tracer({ now: clk.now, exporter });
    expect(() =>
      tracer.withSpan('boom', () => {
        throw new Error('kaboom');
      })
    ).toThrow('kaboom');
    const s = exporter.spans[0];
    expect(s.status.code).toBe('error');
    expect(s.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('feeds span duration into a metrics histogram', () => {
    const clk = fakeClock(0);
    const hist = new Histogram('span_ms');
    const tracer = new Tracer({ now: clk.now, durationHistogram: hist });
    const s = startRpcSpan(tracer, { method: 'act', transport: 'ws' });
    clk.advance(8);
    s.end();
    const snap = hist.snapshot().find((x) => x.labels.span === 'poker.rpc')!;
    expect(snap.count).toBe(1);
    expect(snap.sum).toBe(8);
  });

  it('withSpan handles async and auto-ends', async () => {
    const clk = fakeClock(100);
    const exporter = new InMemorySpanExporter();
    const tracer = new Tracer({ now: clk.now, exporter });
    const result = await tracer.withSpan('async-op', async (span) => {
      span.setAttribute('k', 'v');
      clk.advance(5);
      return 99;
    });
    expect(result).toBe(99);
    expect(exporter.spans[0].attributes.k).toBe('v');
    expect(exporter.spans[0].endTime).not.toBeNull();
  });
});
