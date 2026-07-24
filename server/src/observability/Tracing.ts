/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TRACING — Lightweight Span / Timer API (per-hand, per-action, per-RPC)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FOUNDATION MODULE — self-contained, no engine dependencies, NOT yet wired.
 *
 * Provides a minimal, OpenTelemetry-shaped span model without pulling the full
 * OTel SDK. Spans carry name, timing, attributes, status, events and a parent
 * link. A `SpanExporter` SEAM lets a follow-up bridge these into an OTel
 * TracerProvider / OTLP span exporter; `InMemorySpanExporter` covers tests.
 *
 * Convenience factories (`startHandSpan`, `startActionSpan`, `startRpcSpan`)
 * name spans and set the standard attributes used by the poker engine.
 *
 * Optionally, on span end the Tracer forwards the span duration to a
 * `Histogram` (from Metrics.ts) so a single instrumentation call feeds both
 * traces and latency percentiles.
 *
 * ── WIRING (follow-up) ──
 *   - Wrap ServerTableEngine.processAction() body in an action span.
 *   - Wrap HandController hand lifecycle in a hand span (parent of action spans).
 *   - Wrap router.ts dispatch in an rpc span.
 * ────────────────────────
 */

import type { Histogram } from './Metrics.js';

export type SpanStatusCode = 'unset' | 'ok' | 'error';
export type AttributeValue = string | number | boolean;

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, AttributeValue>;
}

export interface ReadonlySpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  attributes: Record<string, AttributeValue>;
  events: SpanEvent[];
  status: { code: SpanStatusCode; message?: string };
}

/** OpenTelemetry-compatible export SEAM. */
export interface SpanExporter {
  export(span: ReadonlySpan): void | Promise<void>;
}

let idCounter = 0;
function genId(prefix: string): string {
  idCounter = (idCounter + 1) >>> 0;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class Span implements ReadonlySpan {
  endTime: number | null = null;
  readonly attributes: Record<string, AttributeValue> = {};
  readonly events: SpanEvent[] = [];
  status: { code: SpanStatusCode; message?: string } = { code: 'unset' };
  private ended = false;

  constructor(
    public readonly traceId: string,
    public readonly spanId: string,
    public readonly parentSpanId: string | null,
    public readonly name: string,
    public readonly startTime: number,
    private readonly onEnd: (span: Span) => void,
    private readonly now: () => number,
    attributes: Record<string, AttributeValue> = {}
  ) {
    Object.assign(this.attributes, attributes);
  }

  get durationMs(): number | null {
    return this.endTime === null ? null : this.endTime - this.startTime;
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, AttributeValue>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  addEvent(name: string, attributes: Record<string, AttributeValue> = {}): this {
    this.events.push({ name, timestamp: this.now(), attributes });
    return this;
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    this.status = { code, message };
    return this;
  }

  recordException(err: unknown): this {
    const message = err instanceof Error ? err.message : String(err);
    this.addEvent('exception', { 'exception.message': message });
    this.setStatus('error', message);
    return this;
  }

  end(): number {
    if (this.ended) return this.durationMs ?? 0;
    this.ended = true;
    this.endTime = this.now();
    if (this.status.code === 'unset') this.status = { code: 'ok' };
    this.onEnd(this);
    return this.durationMs ?? 0;
  }

  toReadonly(): ReadonlySpan {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.durationMs,
      attributes: { ...this.attributes },
      events: this.events.map((e) => ({ ...e, attributes: { ...e.attributes } })),
      status: { ...this.status },
    };
  }
}

export interface TracerOptions {
  now?: () => number;
  exporter?: SpanExporter;
  /** Optional histogram fed the span duration (ms) on end, keyed by span name via labels. */
  durationHistogram?: Histogram;
}

export interface StartSpanOptions {
  parent?: Span | ReadonlySpan | null;
  attributes?: Record<string, AttributeValue>;
}

export class Tracer {
  private readonly now: () => number;
  private readonly exporter?: SpanExporter;
  private readonly durationHistogram?: Histogram;

  constructor(opts: TracerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.exporter = opts.exporter;
    this.durationHistogram = opts.durationHistogram;
  }

  startSpan(name: string, opts: StartSpanOptions = {}): Span {
    const parent = opts.parent ?? null;
    const traceId = parent ? parent.traceId : genId('t');
    const spanId = genId('s');
    const parentSpanId = parent ? parent.spanId : null;
    return new Span(
      traceId,
      spanId,
      parentSpanId,
      name,
      this.now(),
      (span) => this.handleEnd(span),
      this.now,
      opts.attributes ?? {}
    );
  }

  /** Run `fn` inside a span; auto-ends and records exceptions. Sync or async. */
  withSpan<T>(name: string, fn: (span: Span) => T, opts: StartSpanOptions = {}): T {
    const span = this.startSpan(name, opts);
    try {
      const result = fn(span);
      if (result instanceof Promise) {
        return result
          .then((v) => {
            span.end();
            return v;
          })
          .catch((err) => {
            span.recordException(err);
            span.end();
            throw err;
          }) as unknown as T;
      }
      span.end();
      return result;
    } catch (err) {
      span.recordException(err);
      span.end();
      throw err;
    }
  }

  private handleEnd(span: Span): void {
    if (this.durationHistogram && span.durationMs !== null) {
      this.durationHistogram.observe(span.durationMs, { span: span.name });
    }
    if (this.exporter) void this.exporter.export(span.toReadonly());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Poker-domain span factories (standard names + attributes)
// ─────────────────────────────────────────────────────────────────────────────

export function startHandSpan(
  tracer: Tracer,
  args: { tableId: string; handNumber: number; variant?: string }
): Span {
  return tracer.startSpan('poker.hand', {
    attributes: {
      'poker.table_id': args.tableId,
      'poker.hand_number': args.handNumber,
      ...(args.variant ? { 'poker.variant': args.variant } : {}),
    },
  });
}

export function startActionSpan(
  tracer: Tracer,
  args: { tableId: string; userId: string; action: string; parent?: Span | ReadonlySpan | null }
): Span {
  return tracer.startSpan('poker.action', {
    parent: args.parent ?? null,
    attributes: {
      'poker.table_id': args.tableId,
      'poker.user_id': args.userId,
      'poker.action': args.action,
    },
  });
}

export function startRpcSpan(
  tracer: Tracer,
  args: { method: string; transport: 'http' | 'ws'; parent?: Span | ReadonlySpan | null }
): Span {
  return tracer.startSpan('poker.rpc', {
    parent: args.parent ?? null,
    attributes: { 'rpc.method': args.method, 'rpc.transport': args.transport },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exporters
// ─────────────────────────────────────────────────────────────────────────────

export class InMemorySpanExporter implements SpanExporter {
  readonly spans: ReadonlySpan[] = [];
  constructor(private readonly max = 1000) {}
  export(span: ReadonlySpan): void {
    this.spans.push(span);
    if (this.spans.length > this.max) this.spans.shift();
  }
  clear(): void {
    this.spans.length = 0;
  }
  byName(name: string): ReadonlySpan[] {
    return this.spans.filter((s) => s.name === name);
  }
}
