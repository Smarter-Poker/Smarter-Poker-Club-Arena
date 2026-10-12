/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ACTION-LATENCY LEDGER (Lightning Phase 12, 2026-10-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Spec "ACTION LATENCY TELEMETRY": track each leg separately and collect
 * P50, P95 and P99. "Do not optimize blindly. Measure baseline first." This
 * module is that baseline: one per Cluster worker, it keeps a bounded sample
 * of every leg the engine measures and, once per window, reports each leg's
 * n/p50/p95/p99 through `fn_lightning_latency_report`.
 *
 * THE LEGS (the DB contract's keys, the engine's segment in brackets):
 *
 *   fold_ack                  fold request -> server acknowledgement
 *   ack_to_idle               [ack_to_idle_pool] server ack -> idle pool
 *   idle_to_match             [idle_pool_to_match] idle pool -> match
 *   match_to_hand             match -> hand creation
 *   hand_to_first_render      hand creation -> first client render, on the
 *                             ENGINE's clock: the host's first frame of the
 *                             hand to a room, then that room's RENDER_ACK
 *   fast_fold_to_next_hand    LIGHTNING FOLD -> next hand
 *   normal_fold_to_next_hand  normal fold -> next hand
 *   fold_watch_to_next_hand   FOLD & WATCH -> next hand
 *
 * WINDOWS. Aligned to the wall clock (`latency_window_ms`, one minute by
 * default), except the very first window of a ledger, which starts the
 * moment it begins recording: a restarted worker (or a new process) never
 * reports a window_from its predecessor already reported, so the database's
 * idempotency key (cluster, window_from) never sees two different bodies.
 * A window without a single sample sends nothing: inert without traffic.
 *
 * ONE FLUSH IN FLIGHT, AND A RETRY IS THE SAME CALL. A closed window is
 * frozen once into the exact RPC arguments and queued (at most
 * LIGHTNING_LATENCY_MAX_QUEUED; the oldest is dropped and counted beyond
 * that). A transport failure (outcome unknown) retries the SAME frozen
 * arguments after a backoff, so a retry can only replay what the database
 * may already hold and never meets IDEMPOTENCY_CONFLICT. A refusal is
 * final for that window. "Function not found" (the DB half not deployed
 * yet) is ten minutes of quiet: the queue is dropped and nothing is called,
 * never a loop, never a fault.
 *
 * NEVER A MATCHER INPUT. Nothing in the matcher, the worker's pass or the
 * shadow model reads this module; it reads only milliseconds. NO CARDS: it
 * is never told a card, an action or an amount. HORSES ARE PLAYERS (CLAUDE.md
 * 10.5): it does not know who is one; a seat whose room has no socket simply
 * produces no render sample.
 */
import {
  LIGHTNING_FAILURE_LOG_INTERVAL_MS,
  LIGHTNING_LATENCY_WINDOW_DEFAULT_MS,
  type LightningLatencyConfig,
} from './LightningConfig.js';
import { lightningLatencyReport, type LightningRpcClient } from './LightningRpc.js';
import {
  BoundedSample,
  lightningTelemetry,
  quantileSorted,
  type LightningLatencySink,
  type LightningTelemetry,
} from './LightningTelemetry.js';
import { LIGHTNING_LATENCY_SEGMENTS, type LightningLatencySegment } from './LightningMetrics.js';
import { RateLimitedLog } from './RateLimitedLog.js';
import type { LightningWorkerLogger } from './LightningClusterWorker.js';

/** The engine segment -> the DB contract's leg key (fn_lightning_latency_report p_legs). */
export const LIGHTNING_LATENCY_LEG_KEYS: Readonly<Record<LightningLatencySegment, string>> =
  Object.freeze({
    fold_ack: 'fold_ack',
    ack_to_idle_pool: 'ack_to_idle',
    idle_pool_to_match: 'idle_to_match',
    match_to_hand: 'match_to_hand',
    hand_to_first_render: 'hand_to_first_render',
    fast_fold_to_next_hand: 'fast_fold_to_next_hand',
    normal_fold_to_next_hand: 'normal_fold_to_next_hand',
    fold_watch_to_next_hand: 'fold_watch_to_next_hand',
  });

/** After "function not found", fn_lightning_latency_report is not called for this long. */
export const LIGHTNING_LATENCY_RPC_RETRY_MS = 10 * 60_000;
/** Samples kept per leg per window (reservoir beyond it). */
export const LIGHTNING_LATENCY_SAMPLE_CAP = 2_048;
/** Closed windows waiting for their flush; the oldest is dropped beyond this. */
export const LIGHTNING_LATENCY_MAX_QUEUED = 6;
/** Transport failures one window may take before it is dropped. */
export const LIGHTNING_LATENCY_MAX_ATTEMPTS = 5;
/** The first retry's wait; it doubles, up to the cap. */
export const LIGHTNING_LATENCY_RETRY_BASE_MS = 5_000;
export const LIGHTNING_LATENCY_RETRY_MAX_MS = 60_000;
/** A single sample above this is a broken clock, not a latency (dropped). */
export const LIGHTNING_LATENCY_MAX_SAMPLE_MS = 15 * 60_000;

/** One leg as the DB takes it. */
export interface LightningLatencyLeg {
  n: number;
  p50: number;
  p95: number;
  p99: number;
}

/** The exact, frozen arguments of one window's report (reused verbatim by every retry). */
export interface LightningLatencyReportArgs {
  readonly p_cluster_id: string;
  readonly p_window_from: string;
  readonly p_window_to: string;
  readonly p_legs: Readonly<Record<string, Readonly<LightningLatencyLeg>>>;
}

interface QueuedWindow {
  args: LightningLatencyReportArgs;
  attempts: number;
  nextAtMs: number;
}

export interface LightningLatencyLedgerDeps {
  rpc: LightningRpcClient;
  telemetry?: LightningTelemetry;
  logger?: LightningWorkerLogger;
  now?: () => Date;
}

const consoleLogger: LightningWorkerLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ''),
};

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** One leg's summary from a bounded sample, or null when it holds nothing. */
export function summarizeLatencyLeg(sample: BoundedSample): LightningLatencyLeg | null {
  if (sample.count === 0) return null;
  const sorted = sample.sortedValues();
  return {
    n: sample.count,
    p50: round1(quantileSorted(sorted, 0.5) ?? 0),
    p95: round1(quantileSorted(sorted, 0.95) ?? 0),
    p99: round1(quantileSorted(sorted, 0.99) ?? 0),
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export class LightningLatencyLedger implements LightningLatencySink {
  private config: LightningLatencyConfig | null = null;
  private readonly telemetry: LightningTelemetry;
  private readonly logger: LightningWorkerLogger;
  private readonly now: () => Date;
  private readonly failureLog = new RateLimitedLog(LIGHTNING_FAILURE_LOG_INTERVAL_MS, 8);
  private registered = false;
  private stopped = false;

  private windowStartMs: number | null = null;
  private windowEndMs = 0;
  private samples = new Map<LightningLatencySegment, BoundedSample>();
  private readonly queue: QueuedWindow[] = [];
  private flushing: Promise<void> | null = null;
  private unavailableUntil = 0;
  private sent = 0;
  private dropped = 0;
  private refused = 0;
  private calls = 0;

  constructor(
    readonly clusterId: string,
    private readonly deps: LightningLatencyLedgerDeps
  ) {
    this.telemetry = deps.telemetry ?? lightningTelemetry;
    this.logger = deps.logger ?? consoleLogger;
    this.now = deps.now ?? (() => new Date());
  }

  /** Is the ledger recording? (Off is zero work.) */
  get active(): boolean {
    return !this.stopped && this.config !== null;
  }

  /** Windows the database accepted. */
  get recordsSent(): number {
    return this.sent;
  }

  /** Windows given up on (queue overflow, retries exhausted, function absent). */
  get droppedWindows(): number {
    return this.dropped;
  }

  /** Windows the database refused (final). */
  get refusedWindows(): number {
    return this.refused;
  }

  /** fn_lightning_latency_report calls made (every attempt). */
  get rpcCalls(): number {
    return this.calls;
  }

  /** Closed windows not yet answered. */
  get queued(): number {
    return this.queue.length;
  }

  /** Samples held in the open window (memory bound checks). */
  get heldSamples(): number {
    let n = 0;
    for (const s of this.samples.values()) n += Math.min(s.count, LIGHTNING_LATENCY_SAMPLE_CAP);
    return n;
  }

  /** The config's latency keys; off drops every bit of state. */
  configure(config: LightningLatencyConfig | undefined): void {
    if (this.stopped) return;
    const prev = this.config;
    this.config = config && config.enabled ? { ...config } : null;
    if (!this.config) {
      if (this.registered) this.telemetry.unregisterLatency(this.clusterId, this);
      this.registered = false;
      if (prev) this.resetAll();
      return;
    }
    if (!this.registered) {
      this.telemetry.registerLatency(this.clusterId, this);
      this.registered = true;
    }
    if (prev && prev.windowMs !== this.config.windowMs && this.windowStartMs !== null) {
      // A new window size: the open window closes here, the next one starts now.
      const nowMs = this.now().getTime();
      this.closeWindow(Math.max(this.windowStartMs + 1, nowMs));
      this.openWindow(nowMs, true);
    }
  }

  // ─── THE SINK (LightningTelemetry; cheap, never throws) ─────────────────

  latency(segment: LightningLatencySegment, ms: number): void {
    if (!this.config || this.stopped) return;
    if (!Number.isFinite(ms) || ms < 0 || ms > LIGHTNING_LATENCY_MAX_SAMPLE_MS) return;
    if (!LIGHTNING_LATENCY_LEG_KEYS[segment]) return;
    this.roll(this.now().getTime());
    let s = this.samples.get(segment);
    if (!s) {
      s = new BoundedSample(LIGHTNING_LATENCY_SAMPLE_CAP, 0x1a7e + segment.length * 31);
      this.samples.set(segment, s);
    }
    s.add(ms);
  }

  /**
   * The worker's pass clock: close a window that has ended and drive the
   * flush queue. Never throws, never awaited by the pass.
   */
  tick(nowMs: number = this.now().getTime()): void {
    if (!this.config || this.stopped) return;
    try {
      this.roll(nowMs);
      this.pump(nowMs);
    } catch (err) {
      if (this.failureLog.shouldLog('tick')) {
        this.logger.error(`[LightningLatency:${this.clusterId}] tick failed; play unaffected`, err);
      }
    }
  }

  /**
   * Stop: the open window is closed and every queued window gets one more
   * try (bounded by the worker's stop drain). Unregistered either way.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    const nowMs = this.now().getTime();
    if (this.config && this.windowStartMs !== null) {
      try {
        this.closeWindow(Math.max(this.windowStartMs + 1, nowMs));
      } catch {
        // nothing to close
      }
    }
    this.stopped = true;
    if (this.registered) this.telemetry.unregisterLatency(this.clusterId, this);
    this.registered = false;
    if (this.flushing) await this.flushing.catch(() => undefined);
    // One more try each, now, regardless of backoff (the process may be going away).
    const tries = this.queue.length;
    for (let i = 0; i < tries && this.queue.length > 0; i++) {
      if (this.unavailableUntil > this.now().getTime()) break;
      const head = this.queue[0];
      const before = this.queue.length;
      await this.send(head);
      if (this.queue.length === before && this.queue[0] === head) break; // transport still down
    }
    this.samples = new Map();
    this.windowStartMs = null;
  }

  /** Resolves when the flush in flight (if any) has finished. For tests. */
  async settled(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => undefined);
  }

  // ─── WINDOWS ────────────────────────────────────────────────────────────

  private windowMs(): number {
    return this.config?.windowMs ?? LIGHTNING_LATENCY_WINDOW_DEFAULT_MS;
  }

  /** Open a window at `nowMs`: exact when `exact` (the first), else aligned. */
  private openWindow(nowMs: number, exact: boolean): void {
    const w = this.windowMs();
    const aligned = Math.floor(nowMs / w) * w;
    this.windowStartMs = exact ? nowMs : aligned;
    this.windowEndMs = aligned + w;
    this.samples = new Map();
  }

  private roll(nowMs: number): void {
    if (this.windowStartMs === null) {
      this.openWindow(nowMs, true);
      return;
    }
    if (nowMs < this.windowEndMs) return;
    this.closeWindow(this.windowEndMs);
    this.openWindow(nowMs, false);
  }

  /** Freeze the open window's report (if it holds anything) and queue it. */
  private closeWindow(toMs: number): void {
    const fromMs = this.windowStartMs;
    const samples = this.samples;
    this.samples = new Map();
    if (fromMs === null || toMs <= fromMs) return;
    const legs: Record<string, LightningLatencyLeg> = {};
    for (const seg of LIGHTNING_LATENCY_SEGMENTS) {
      const s = samples.get(seg);
      const leg = s ? summarizeLatencyLeg(s) : null;
      if (leg) legs[LIGHTNING_LATENCY_LEG_KEYS[seg]] = leg;
    }
    if (Object.keys(legs).length === 0) return; // no traffic, nothing to say
    if (this.unavailableUntil > this.now().getTime()) {
      this.dropped++;
      return;
    }
    const args: LightningLatencyReportArgs = deepFreeze({
      p_cluster_id: this.clusterId,
      p_window_from: new Date(fromMs).toISOString(),
      p_window_to: new Date(toMs).toISOString(),
      p_legs: legs,
    });
    this.queue.push({ args, attempts: 0, nextAtMs: 0 });
    while (this.queue.length > LIGHTNING_LATENCY_MAX_QUEUED) {
      // Never the head while it is in flight: its answer is still owed to it.
      const idx = this.flushing ? 1 : 0;
      this.queue.splice(idx, 1);
      this.dropped++;
      if (this.failureLog.shouldLog('queue_overflow')) {
        this.logger.warn(
          `[LightningLatency:${this.clusterId}] report queue full; the oldest window was dropped`
        );
      }
    }
  }

  // ─── FLUSH ──────────────────────────────────────────────────────────────

  private pump(nowMs: number): void {
    if (this.flushing || this.queue.length === 0) return;
    if (this.unavailableUntil > nowMs) return;
    const head = this.queue[0];
    if (head.nextAtMs > nowMs) return;
    const run = this.send(head).finally(() => {
      if (this.flushing === run) this.flushing = null;
      // The next queued window goes at once (still one in flight at a time).
      if (!this.stopped && this.config) this.pump(this.now().getTime());
    });
    this.flushing = run;
  }

  /** One attempt for the queue's head. Never throws. */
  private async send(head: QueuedWindow): Promise<void> {
    head.attempts++;
    this.calls++;
    const out = await lightningLatencyReport(this.deps.rpc, head.args).catch((error: unknown) => ({
      status: 'error' as const,
      error,
    }));
    const nowMs = this.now().getTime();
    if (out.status === 'ok') {
      this.removeHead(head);
      const v = out.value as Record<string, unknown> | null;
      if (v && typeof v === 'object' && v.ok === false) {
        this.refused++;
        const reason = String(v.code ?? v.reason ?? 'unknown');
        if (this.failureLog.shouldLog(`refused:${reason}`)) {
          const line = `[LightningLatency:${this.clusterId}] fn_lightning_latency_report refused the window (${reason})`;
          if (reason === 'IDEMPOTENCY_CONFLICT') this.logger.error(line);
          else this.logger.warn(line);
        }
        return;
      }
      this.sent++;
      return;
    }
    if (out.status === 'unavailable') {
      this.unavailableUntil = nowMs + LIGHTNING_LATENCY_RPC_RETRY_MS;
      this.dropped += this.queue.length;
      this.queue.length = 0;
      if (this.failureLog.shouldLog('unavailable')) {
        this.logger.warn(
          `[LightningLatency:${this.clusterId}] fn_lightning_latency_report is not deployed yet; windows dropped for 10 minutes`
        );
      }
      return;
    }
    if (out.status === 'invalid') {
      this.removeHead(head);
      this.refused++;
      return;
    }
    // Transport: outcome unknown. The SAME frozen arguments are tried again later.
    if (head.attempts >= LIGHTNING_LATENCY_MAX_ATTEMPTS) {
      this.removeHead(head);
      this.dropped++;
      if (this.failureLog.shouldLog('exhausted')) {
        this.logger.error(
          `[LightningLatency:${this.clusterId}] window ${head.args.p_window_from} unconfirmed after ${head.attempts} attempts; dropped`,
          out.error
        );
      }
      return;
    }
    head.nextAtMs =
      nowMs +
      Math.min(
        LIGHTNING_LATENCY_RETRY_MAX_MS,
        LIGHTNING_LATENCY_RETRY_BASE_MS * 2 ** (head.attempts - 1)
      );
    if (this.failureLog.shouldLog('transport')) {
      this.logger.warn(
        `[LightningLatency:${this.clusterId}] fn_lightning_latency_report unanswered; the same window is retried`
      );
    }
  }

  private removeHead(head: QueuedWindow): void {
    const i = this.queue.indexOf(head);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private resetAll(): void {
    this.samples = new Map();
    this.windowStartMs = null;
    this.windowEndMs = 0;
    this.queue.length = 0;
  }
}
