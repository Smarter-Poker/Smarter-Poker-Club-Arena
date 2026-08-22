/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EquityWorkerPool — worker_threads pool for all-in / insurance equity
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs Monte-Carlo equity OFF the shared Node event loop. N = (cores - 1)
 * workers, a promise-based API, and a job queue. The previous synchronous
 * `monteCarloEquity(...,5000)` (with a crypto syscall per Fisher-Yates swap) froze
 * every table for hundreds of ms to seconds on every all-in; this removes it from
 * the main loop entirely.
 *
 * Safe degradation: if worker_threads cannot spawn (dev/tsx, tests, missing
 * build artifact) OR a worker dies mid-job, estimateEquity transparently falls
 * back to the SAME `computeEquity` synchronously — the caller always gets a
 * correct, deterministic result; it just isn't offloaded in that mode.
 */
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import type { Card } from '../../types.js';
import { computeEquity, type EquityOptions } from './equityWorker.js';
import { hashSeed } from './SeededRandom.js';

interface JobPayload {
  hands: Card[][];
  board: Card[];
  deadCards: Card[];
  iters: number;
  opts: EquityOptions;
  seed: number;
}

interface Job {
  id: number;
  payload: JobPayload;
  resolve: (equities: number[]) => void;
  /** FIX 2026-08-22: single-settle guard — timeout, worker reply and
   *  worker-death recovery can all race to resolve the same job. */
  settled?: boolean;
  /** Per-job watchdog handle, armed at enqueue time. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * FIX 2026-08-22: hard bound on how long ANY equity job may remain
 * unresolved. estimateEquity's promise is awaited on the all-in runout
 * critical path (broadcastAllInEquity -> safeContinueRunout); a worker that
 * wedged without exiting used to leave that promise pending FOREVER, parking
 * the hand at ALL_IN_RUNOUT until the table watchdog killed the engine — and
 * because jobs queue, one wedged pool stalled every all-in on every table.
 * The clock starts at enqueue so queue-wait behind a wedged pool is bounded
 * too. On expiry: a queued job is pulled and computed synchronously; an
 * in-flight job's worker is terminated (its 'exit' recovery resolves the job
 * via the same sync fallback and respawns a replacement).
 */
const JOB_TIMEOUT_MS = 15_000;

export class EquityWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private inFlight = new Map<Worker, Job>();
  private nextId = 1;
  private readonly size: number;
  private initialized = false;
  private readonly disabled: boolean;
  private readonly workerUrl: URL;

  constructor(opts?: { size?: number; disabled?: boolean }) {
    this.size = Math.max(1, opts?.size ?? cpus().length - 1);
    this.disabled = !!opts?.disabled || process.env.EQUITY_WORKERS === 'off';
    this.workerUrl = new URL('./equityWorker.js', import.meta.url);
  }

  /** Lazily spawn the worker threads on first use. */
  private init(): void {
    if (this.initialized || this.disabled) return;
    this.initialized = true;
    for (let i = 0; i < this.size; i++) {
      try {
        const w = new Worker(this.workerUrl);
        w.on('message', (m) => this.onMessage(w, m));
        w.on('error', () => this.onWorkerDown(w));
        w.on('exit', () => this.onWorkerDown(w));
        w.unref(); // never keep the process alive for equity
        this.workers.push(w);
        this.idle.push(w);
      } catch {
        // Synchronous spawn failure — leave this slot empty; we degrade to sync.
      }
    }
  }

  /** True when at least one live worker exists (i.e. equity is being offloaded). */
  isAvailable(): boolean {
    this.init();
    return this.workers.length > 0;
  }

  /**
   * Estimate each hand's equity fraction [0,1] via Monte-Carlo on a worker
   * thread (or synchronously if none is available). Deterministic per
   * (seed, inputs).
   */
  estimateEquity(
    hands: Card[][],
    board: Card[],
    deadCards: Card[] = [],
    iters = 1000,
    opts: EquityOptions = {},
    seed?: number
  ): Promise<number[]> {
    this.init();
    const useSeed = seed ?? this.deriveSeed(hands, board, deadCards, iters);

    if (this.workers.length === 0) {
      // Degraded mode: synchronous compute (still correct + deterministic).
      return Promise.resolve(computeEquity(hands, board, deadCards, iters, opts, useSeed));
    }

    return new Promise<number[]>((resolve) => {
      const job: Job = {
        id: this.nextId++,
        payload: { hands, board, deadCards, iters, opts, seed: useSeed },
        resolve,
      };
      job.timer = setTimeout(() => this.onJobTimeout(job), JOB_TIMEOUT_MS);
      job.timer.unref?.();
      this.queue.push(job);
      this.pump();
    });
  }

  /** See JOB_TIMEOUT_MS. Never lets an equity await park a hand. */
  private onJobTimeout(job: Job): void {
    if (job.settled) return;
    // Still waiting in the queue? Pull it and answer synchronously.
    const qIdx = this.queue.indexOf(job);
    if (qIdx !== -1) {
      this.queue.splice(qIdx, 1);
      this.settle(job, this.syncFallback(job));
      return;
    }
    // In flight on a wedged worker: terminate it. The worker's 'exit' handler
    // (onWorkerDown) recovers the job via syncFallback and respawns.
    for (const [w, inFlightJob] of this.inFlight) {
      if (inFlightJob === job) {
        void w.terminate().catch(() => {});
        return;
      }
    }
    // Neither queued nor in flight and not settled — settle defensively.
    this.settle(job, this.syncFallback(job));
  }

  /** Resolve exactly once and clear the watchdog. */
  private settle(job: Job, equities: number[]): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.resolve(equities);
  }

  private deriveSeed(hands: Card[][], board: Card[], dead: Card[], iters: number): number {
    const keys: string[] = [];
    for (const h of hands) for (const c of h) keys.push(`h${c.rank}${c.suit}`);
    for (const c of board) keys.push(`b${c.rank}${c.suit}`);
    for (const c of dead) keys.push(`d${c.rank}${c.suit}`);
    keys.sort();
    return hashSeed(iters, ...keys);
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.inFlight.set(w, job);
      w.postMessage({ id: job.id, ...job.payload });
    }
  }

  private onMessage(w: Worker, m: any): void {
    const job = this.inFlight.get(w);
    this.inFlight.delete(w);
    if (this.workers.includes(w)) this.idle.push(w);
    if (job) {
      if (m && !m.error && Array.isArray(m.equities)) {
        this.settle(job, m.equities);
      } else {
        // Worker reported an error — recover with the synchronous compute.
        this.settle(job, this.syncFallback(job));
      }
    }
    this.pump();
  }

  private onWorkerDown(w: Worker): void {
    const wasKnown = this.workers.includes(w);
    this.workers = this.workers.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    const job = this.inFlight.get(w);
    if (job) {
      this.inFlight.delete(w);
      // Do not drop the job — recover it via the synchronous compute.
      this.settle(job, this.syncFallback(job));
    }
    // FIX 2026-08-22: the pool used to shrink permanently on every worker
    // death until nothing was offloaded any more. Respawn a replacement
    // (single attempt, guarded — a broken build artifact just degrades to
    // sync mode exactly as before).
    if (wasKnown && !this.disabled && this.workers.length < this.size) {
      try {
        const nw = new Worker(this.workerUrl);
        nw.on('message', (m) => this.onMessage(nw, m));
        nw.on('error', () => this.onWorkerDown(nw));
        nw.on('exit', () => this.onWorkerDown(nw));
        nw.unref();
        this.workers.push(nw);
        this.idle.push(nw);
      } catch {
        /* degrade to sync mode */
      }
    }
    this.pump();
  }

  private syncFallback(job: Job): number[] {
    const p = job.payload;
    return computeEquity(p.hands, p.board, p.deadCards, p.iters, p.opts, p.seed);
  }

  async shutdown(): Promise<void> {
    for (const w of this.workers) {
      try {
        await w.terminate();
      } catch {
        /* ignore */
      }
    }
    this.workers = [];
    this.idle = [];
  }
}

let _pool: EquityWorkerPool | null = null;

/** Process-wide shared equity pool (lazy). */
export function getEquityPool(): EquityWorkerPool {
  if (!_pool) _pool = new EquityWorkerPool();
  return _pool;
}
