/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE LIGHTNING CLUSTER'S WORKER - SHADOW MODE ONLY (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The clock for one Cluster's matcher. Each pass:
 *
 *   1. reads the presence feed for the Cluster's anchor tables
 *      (LightningPresence - fail closed: unknown counts as disconnected);
 *   2. makes EXACTLY ONE RPC, `fn_lightning_match` - STABLE, writes nothing;
 *   3. validates the answer against the contract and records a summary: the
 *      counts go to metrics every pass, the log line at most once per
 *      keepalive interval (or when the summary changes, rate-limited).
 *
 * WHY SHADOW. It lets the SQL matcher be judged against live pools - who it
 * would have grouped, who it would have held and why - with nothing at stake.
 *
 * WHY 'form' IS REFUSED. `fn_lightning_match_and_form` writes formed hands.
 * Nothing in this engine deals a Lightning hand yet, so a formed hand would
 * have no dealer and would sit until the reaper took it - holding its players
 * out of every other hand for that long. Until the dealing host exists, a
 * Cluster configured 'form' gets a worker that says so (rate-limited) and
 * makes no RPC at all. The refusal is here, in the one class that could
 * call the writer, rather than trusted to a config value.
 *
 * TIMERS. One setTimeout at a time, armed only after the previous pass has
 * finished (no overlap, no pile-up behind a slow database), unref'd so it
 * never holds the process open, and cleared by stop(), which also waits for a
 * pass already in flight. A stopped worker cannot be restarted: the
 * supervisor makes a new one.
 */
import {
  LIGHTNING_FAILURE_LOG_INTERVAL_MS,
  LIGHTNING_STOP_DRAIN_MS,
  type LightningConfig,
} from './LightningConfig.js';
import {
  lightningMatch,
  summarizeLightningMatch,
  type LightningDiagnosisSummary,
  type LightningRpcClient,
} from './LightningRpc.js';
import type { LightningPresence } from './LightningPresence.js';
import {
  lightningMetrics,
  type LightningMetrics,
  type LightningPassOutcome,
} from './LightningMetrics.js';
import { RateLimitedLog } from './RateLimitedLog.js';

export interface LightningWorkerLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface LightningClusterWorkerDeps {
  rpc: LightningRpcClient;
  presence: LightningPresence;
  metrics?: LightningMetrics;
  logger?: LightningWorkerLogger;
  now?: () => Date;
  /** The platform freeze (CLAUDE.md 13): no pass, no I/O, while it holds. */
  frozen?: () => boolean;
}

export type LightningWorkerPassResult =
  | { outcome: 'matched'; summary: LightningDiagnosisSummary; disconnected: number }
  | { outcome: Exclude<LightningPassOutcome, 'matched'>; reason?: string };

const consoleLogger: LightningWorkerLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ''),
};

export class LightningClusterWorker {
  private config: LightningConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<LightningWorkerPassResult> | null = null;
  /** Who the last validated diagnosis named: the presence feed's memory of the pool. */
  private knownPoolPlayers: string[] = [];
  private lastSummaryKey: string | null = null;
  private lastSummaryLogAtMs = 0;
  private readonly failureLog = new RateLimitedLog(LIGHTNING_FAILURE_LOG_INTERVAL_MS, 16);
  private readonly metrics: LightningMetrics;
  private readonly logger: LightningWorkerLogger;
  private readonly now: () => Date;
  private readonly frozen: () => boolean;
  private passes = 0;

  constructor(
    readonly clusterId: string,
    config: LightningConfig,
    private readonly deps: LightningClusterWorkerDeps
  ) {
    this.config = { ...config };
    this.metrics = deps.metrics ?? lightningMetrics;
    this.logger = deps.logger ?? consoleLogger;
    this.now = deps.now ?? (() => new Date());
    this.frozen = deps.frozen ?? (() => false);
  }

  get mode(): LightningConfig['workerMode'] {
    return this.config.workerMode;
  }

  get currentConfig(): LightningConfig {
    return { ...this.config };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get passCount(): number {
    return this.passes;
  }

  /** Arm the first pass. Idempotent; a stopped worker stays stopped. */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.logger.log(
      `[Lightning:${this.clusterId}] worker started in ${this.config.workerMode} mode ` +
        `(pass every ${this.config.passIntervalMs}ms)`
    );
    this.arm(0);
  }

  /** New config from the supervisor. Takes effect from the next pass. */
  updateConfig(config: LightningConfig): void {
    const modeChanged = config.workerMode !== this.config.workerMode;
    this.config = { ...config };
    if (modeChanged) {
      this.failureLog.forget('form');
      this.logger.log(`[Lightning:${this.clusterId}] worker mode is now ${config.workerMode}`);
    }
  }

  /**
   * Stop for good: no further pass is armed, the pending timer is cleared,
   * and a pass already in flight is waited for (bounded by
   * LIGHTNING_STOP_DRAIN_MS, so a hung RPC cannot hold a shutdown hostage).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.metrics.forgetCluster(this.clusterId);
    const inFlight = this.inFlight;
    if (!inFlight) return;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      inFlight.then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, LIGHTNING_STOP_DRAIN_MS);
        (drainTimer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);
  }

  private arm(delayMs: number): void {
    if (!this.running || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || this.stopped) return;
      const pass = this.pass();
      this.inFlight = pass;
      void pass
        .catch((err) => {
          this.logger.error(`[Lightning:${this.clusterId}] pass threw`, err);
        })
        .finally(() => {
          if (this.inFlight === pass) this.inFlight = null;
          this.arm(this.config.passIntervalMs);
        });
    }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * One pass. Public so the supervisor's tests (and a future operator
   * endpoint) can drive it without timers. Never throws.
   */
  async pass(): Promise<LightningWorkerPassResult> {
    this.passes++;
    const result = await this.runPass();
    this.metrics.recordPass(result.outcome);
    return result;
  }

  private async runPass(): Promise<LightningWorkerPassResult> {
    const mode = this.config.workerMode;
    if (mode === 'off') return { outcome: 'off' };
    if (mode === 'form') {
      if (this.failureLog.shouldLog('form')) {
        this.logger.warn(
          `[Lightning:${this.clusterId}] worker_mode is 'form' but REFUSED: no dealing host exists ` +
            'yet, and a formed hand with no dealer would sit until reaped. Running nothing; set ' +
            "worker_mode to 'shadow' to compare the matcher, or ship the dealing host first."
        );
      }
      return { outcome: 'refused_form', reason: 'dealing_host_not_available' };
    }
    if (this.frozen()) return { outcome: 'frozen' };

    let disconnected: string[];
    try {
      disconnected = this.deps.presence.snapshot(
        this.clusterId,
        this.knownPoolPlayers
      ).pDisconnected;
    } catch (err) {
      // A presence feed that cannot answer must not be read as "everyone is here".
      if (this.failureLog.shouldLog('presence')) {
        this.logger.error(`[Lightning:${this.clusterId}] presence feed failed; pass skipped`, err);
      }
      return { outcome: 'error', reason: 'presence_failed' };
    }

    const out = await lightningMatch(this.deps.rpc, {
      clusterId: this.clusterId,
      now: this.now(),
      disconnected,
      matcherVersion: this.config.matcherVersion,
    });

    if (out.status === 'unavailable') {
      if (this.failureLog.shouldLog('unavailable')) {
        this.logger.warn(
          `[Lightning:${this.clusterId}] fn_lightning_match is not deployed yet - shadow pass skipped`
        );
      }
      return { outcome: 'unavailable', reason: out.reason };
    }
    if (out.status === 'invalid') {
      if (this.failureLog.shouldLog('invalid:' + out.reason)) {
        this.logger.error(
          `[Lightning:${this.clusterId}] fn_lightning_match answered outside its contract (${out.reason})`
        );
      }
      return { outcome: 'invalid', reason: out.reason };
    }
    if (out.status === 'error') {
      if (this.failureLog.shouldLog('error')) {
        this.logger.error(`[Lightning:${this.clusterId}] fn_lightning_match failed`, out.error);
      }
      return { outcome: 'error', reason: 'rpc_failed' };
    }

    const result = out.value;
    this.knownPoolPlayers = result.diagnosis.map((d) => d.playerId);
    const summary = summarizeLightningMatch(result);
    this.metrics.recordSummary(this.clusterId, summary);
    this.maybeLogSummary(summary, disconnected.length);
    return { outcome: 'matched', summary, disconnected: disconnected.length };
  }

  /**
   * A changed summary is logged at most once per failure-log interval; an
   * unchanged one once per keepalive interval, so a quiet worker still says
   * it is alive and a busy one cannot flood the log.
   */
  private maybeLogSummary(summary: LightningDiagnosisSummary, disconnected: number): void {
    const key = JSON.stringify([summary.byState, summary.byReason, summary.groups, disconnected]);
    const nowMs = this.now().getTime();
    const changed = key !== this.lastSummaryKey;
    const sinceLast = nowMs - this.lastSummaryLogAtMs;
    const due = changed
      ? sinceLast >= Math.min(this.config.keepaliveIntervalMs, LIGHTNING_FAILURE_LOG_INTERVAL_MS)
      : sinceLast >= this.config.keepaliveIntervalMs;
    if (!due) return;
    this.lastSummaryKey = key;
    this.lastSummaryLogAtMs = nowMs;
    const states = Object.entries(summary.byState)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${s}=${n}`)
      .join(' ');
    const reasons = Object.entries(summary.byReason)
      .map(([r, n]) => `${r}=${n}`)
      .join(' ');
    this.logger.log(
      `[Lightning:${this.clusterId}] shadow: players=${summary.players} groups=${summary.groups} ` +
        `legal=${summary.legalCount} diversity=${summary.poolDiversityScore ?? 'n/a'} ` +
        `withheld_for_presence=${disconnected}` +
        (states ? ` | ${states}` : '') +
        (reasons ? ` | reasons ${reasons}` : '')
    );
  }
}
