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
 * FORM MODE (Lightning Phase 6, 2026-09-27). Each pass makes ONE call to
 * `fn_lightning_match_and_form` with a fresh request id (reused only to retry
 * a pass whose outcome is unknown, which the writer answers from its record),
 * bounded by `maxHandsPerPass`, and hands every formed hand to the dealing
 * host (`startHand`, LightningHosting). A host that frees a player, or ends,
 * wakes the worker so the next pass runs at once instead of a pass interval
 * later. `formation_invariant_failed` means the barrier FROZE the Cluster:
 * the worker stops for good and says so. A worker built without a dealing
 * host still refuses 'form' outright and calls nothing - a formed hand with
 * no dealer would sit until reaped, holding its players out of every hand.
 *
 * DRAINING (Lightning Phase 7, 2026-10-02). A Cluster in `pending_off` is on
 * its way back to MUST MOVE: the database refuses to form, and settles every
 * hand already in the air. Its worker keeps running but DRAINS - each pass
 * calls nothing at all (no matcher, no match_and_form), and says once per
 * keepalive interval that it is draining. The hands in the air are not the
 * worker's: their hosts deal them to settlement and keep their instances
 * alive on their own clock. A Cluster that turns back to `lightning` (the
 * conversion aborted) resumes forming on the next pass.
 *
 * THE SHADOW MATCHER (Lightning Phase 11, 2026-10-08). After a matching or
 * forming pass has RETURNED - its hands already with their hosts - the
 * worker hands the pass's presence snapshot, its `now` and the live
 * decision to its LightningShadowRunner, synchronously, inside a try/catch,
 * and reads nothing back. The runner plans its candidate on its own copy of
 * the population and records the comparison once per window. With
 * `lightning_shadow_matcher` and `integrity_telemetry` off it does nothing.
 *
 * SURGE PROTECTION (Lightning Phase 12, 2026-10-09). Admission is
 * micro-batched: a player whose room's first socket arrives (a join, a
 * reconnect) asks for a pass within LIGHTNING_ADMISSION_COALESCE_MS, so a
 * burst of arrivals is formed together by a few passes rather than one pass
 * per arrival or a pass interval later. A pass whose batch was cut short by
 * the database (`max_hands` - admission_batch_hands - or `time_budget`)
 * leaves a backlog, so the next pass runs at once, up to
 * LIGHTNING_SURGE_MAX_BACK_TO_BACK in a row before the interval applies
 * again. One formation is in flight per Cluster across every worker object
 * of this process (LightningFormationGate), a call that does not answer
 * within LIGHTNING_FORM_RPC_TIMEOUT_MS is treated as outcome-unknown and
 * re-asked under the same request id, and nothing economic is ever formed
 * ahead of a pass: prewarming stops at the room and the table shell.
 *
 * THE LATENCY LEDGER (Lightning Phase 12). Each pass ticks the Cluster's
 * LightningLatencyLedger (window roll and its one flush in flight), after
 * the pass's own work is decided and without reading anything back.
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
import { randomUUID } from 'node:crypto';
import {
  isUuid,
  lightningMatch,
  lightningMatchAndForm,
  summarizeLightningMatch,
  type LightningDiagnosisSummary,
  type LightningPlatformsDelivery,
  type LightningRpcClient,
} from './LightningRpc.js';
import type { LightningDevicePlatform, LightningPresence } from './LightningPresence.js';
import {
  lightningMetrics,
  type LightningMetrics,
  type LightningPassOutcome,
} from './LightningMetrics.js';
import { RateLimitedLog } from './RateLimitedLog.js';
import type { LightningFormedHand } from './LightningHandHost.js';
import { LightningShadowRunner, type LightningDecidedGroup } from './LightningShadowRunner.js';
import type { LightningPresenceSnapshot } from './LightningPresence.js';
import { LightningLatencyLedger } from './LightningLatencyLedger.js';
import {
  LIGHTNING_FORM_RPC_TIMEOUT_MS,
  lightningFormationGate,
  type LightningFormationGate,
} from './LightningFormationGate.js';

/** After the old matcher signature refuses p_player_platforms, ask again this much later. */
export const LIGHTNING_PLATFORMS_RETRY_MS = 10 * 60_000;
/** Arrivals within this window share one forming pass (admission micro-batching). */
export const LIGHTNING_ADMISSION_COALESCE_MS = 250;
/** A saturated pass is followed at once by another, at most this many times in a row. */
export const LIGHTNING_SURGE_MAX_BACK_TO_BACK = 8;
/** The stopped_reason values that mean the batch was cut short with players still waiting. */
const SATURATED_STOP_REASONS = new Set(['max_hands', 'time_budget']);

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
  /** The dealing host. Without it, 'form' is refused. */
  startHand?: (hand: LightningFormedHand) => void;
  /** A host already exists for this instance (a replayed pass names it again). */
  hasInstance?: (instanceId: string) => boolean;
  /** The barrier froze the Cluster: the supervisor drops this worker. */
  onClusterFrozen?: (clusterId: string) => void;
  /**
   * Epoch ms before which this Cluster must not form: consecutive abandoned
   * hands back it off (LightningHosting), a settled hand clears it.
   */
  formBackoffUntil?: () => number;
  /**
   * Does this process hold the verified lease on the Cluster's front table
   * (the host table every hand binds to)? Without it a formed hand could only
   * be abandoned, so the worker does not form.
   */
  holdsFrontTableLease?: () => Promise<boolean>;
  /** LIGHTNING PHASE 11: the shadow runner (one is made when absent). */
  shadow?: LightningShadowRunner;
  /** LIGHTNING PHASE 12: the latency ledger (one is made when absent). */
  latency?: LightningLatencyLedger;
  /** LIGHTNING PHASE 12: the process-wide one-formation-per-Cluster gate. */
  formationGate?: LightningFormationGate;
  /** How long a match_and_form call may go unanswered (tests shorten it). */
  formTimeoutMs?: number;
}

export type LightningWorkerPassResult =
  | { outcome: 'matched'; summary: LightningDiagnosisSummary; disconnected: number }
  | {
      outcome: Exclude<LightningPassOutcome, 'matched'>;
      reason?: string;
      formed?: number;
      /** The database cut the batch short with players still waiting (surge). */
      saturated?: boolean;
    };

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
  /** Epoch ms before which p_player_platforms is not sent (the old signature refused it). */
  private platformsRetryAtMs = 0;
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
  /** The request id of a forming pass whose outcome is unknown: retried as-is. */
  private pendingRequestId: string | null = null;
  private wakeRequested = false;
  /** `pending_off`: form nothing, call nothing; the hands in the air settle. */
  private draining = false;
  private lastDrainLogAtMs = 0;
  /** LIGHTNING PHASE 11: observes each live pass after it returned; never consulted. */
  private readonly shadow: LightningShadowRunner;
  /** LIGHTNING PHASE 12: the per-window latency ledger; never consulted. */
  private readonly latency: LightningLatencyLedger;
  private readonly gate: LightningFormationGate;
  private readonly formTimeoutMs: number;
  /** When the armed timer fires (epoch ms of the process clock), for admission coalescing. */
  private timerDueAtMs = Number.POSITIVE_INFINITY;
  /** Back-to-back passes run because the previous one was saturated. */
  private surgeStreak = 0;
  private lastPassSaturated = false;

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
    this.shadow =
      deps.shadow ??
      new LightningShadowRunner(clusterId, {
        rpc: deps.rpc,
        logger: this.logger,
        now: () => this.now(),
      });
    this.shadow.configure(this.config.shadow);
    this.latency =
      deps.latency ??
      new LightningLatencyLedger(clusterId, {
        rpc: deps.rpc,
        logger: this.logger,
        now: () => this.now(),
      });
    this.latency.configure(this.config.latency);
    this.gate = deps.formationGate ?? lightningFormationGate;
    this.formTimeoutMs = deps.formTimeoutMs ?? LIGHTNING_FORM_RPC_TIMEOUT_MS;
  }

  /** The latency ledger (tests read it; the pass never does). */
  get latencyLedger(): LightningLatencyLedger {
    return this.latency;
  }

  /** The shadow runner (tests and the operator view read it; the pass never does). */
  get shadowRunner(): LightningShadowRunner {
    return this.shadow;
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

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * The supervisor's word on the Cluster's mode: `pending_off` drains,
   * `lightning` forms. Takes effect from the next pass; a pass already in
   * flight finishes (and the database refuses its formation anyway).
   */
  setDraining(draining: boolean): void {
    if (draining === this.draining) return;
    this.draining = draining;
    this.lastDrainLogAtMs = 0;
    this.logger.log(
      draining
        ? `[Lightning:${this.clusterId}] pending_off - forming stopped; hands in the air play on to settlement`
        : `[Lightning:${this.clusterId}] back to lightning - forming resumes`
    );
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
    this.shadow.configure(this.config.shadow);
    this.latency.configure(this.config.latency);
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
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const stopObservers = () =>
      Promise.all([this.shadow.stop(), this.latency.stop()]).then(() => undefined);
    await Promise.race([
      (inFlight ?? Promise.resolve()).then(stopObservers, stopObservers),
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
    this.timerDueAtMs = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAtMs = Number.POSITIVE_INFINITY;
      if (!this.running || this.stopped) return;
      const pass = this.pass();
      this.inFlight = pass;
      void pass
        .catch((err) => {
          this.logger.error(`[Lightning:${this.clusterId}] pass threw`, err);
        })
        .finally(() => {
          if (this.inFlight === pass) this.inFlight = null;
          const woken = this.wakeRequested;
          this.wakeRequested = false;
          // SURGE: a batch the database cut short leaves players waiting, so
          // the next pass runs at once - a bounded number of times in a row.
          const surge =
            this.lastPassSaturated && this.surgeStreak < LIGHTNING_SURGE_MAX_BACK_TO_BACK;
          this.surgeStreak = surge ? this.surgeStreak + 1 : 0;
          this.arm(woken || surge ? 0 : this.config.passIntervalMs);
        });
    }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * LIGHTNING PHASE 12 (admission micro-batching): a player just arrived in
   * this Cluster's pool (their room's first socket). The next pass runs
   * within LIGHTNING_ADMISSION_COALESCE_MS - never later than it would have
   * anyway - so every arrival of a burst is formed by the same few passes.
   */
  admit(): void {
    if (!this.running || this.stopped || this.config.workerMode !== 'form') return;
    if (this.draining) return;
    if (this.inFlight) {
      this.wakeRequested = true;
      return;
    }
    if (this.timerDueAtMs <= Date.now() + LIGHTNING_ADMISSION_COALESCE_MS) return;
    this.arm(LIGHTNING_ADMISSION_COALESCE_MS);
  }

  /**
   * A player was freed or a hand ended: run the next pass now rather than a
   * pass interval from now. A pass in flight is followed at once by another.
   */
  wake(): void {
    if (!this.running || this.stopped || this.config.workerMode !== 'form') return;
    // A draining Cluster forms nothing, so a freed player is no reason to run.
    if (this.draining) return;
    if (this.inFlight) {
      this.wakeRequested = true;
      return;
    }
    this.arm(0);
  }

  /**
   * One pass. Public so the supervisor's tests (and a future operator
   * endpoint) can drive it without timers. Never throws.
   */
  async pass(): Promise<LightningWorkerPassResult> {
    this.passes++;
    const result = await this.runPass();
    this.lastPassSaturated = result.outcome === 'formed' && result.saturated === true;
    this.metrics.recordPass(result.outcome);
    // LIGHTNING PHASE 12: the ledger's clock, after the pass decided everything.
    try {
      this.latency.tick();
    } catch {
      // The ledger never reaches back into a pass.
    }
    return result;
  }

  private async runPass(): Promise<LightningWorkerPassResult> {
    const mode = this.config.workerMode;
    if (mode === 'off') return { outcome: 'off' };
    if (this.draining) return this.drainPass();
    if (mode === 'form' && this.deps.startHand) return this.formPass();
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
    let platforms: Record<string, LightningDevicePlatform>;
    let snap: LightningPresenceSnapshot;
    try {
      snap = this.deps.presence.snapshot(this.clusterId, this.knownPoolPlayers);
      disconnected = snap.pDisconnected;
      platforms = snap.platforms ?? {};
    } catch (err) {
      // A presence feed that cannot answer must not be read as "everyone is here".
      if (this.failureLog.shouldLog('presence')) {
        this.logger.error(`[Lightning:${this.clusterId}] presence feed failed; pass skipped`, err);
      }
      return { outcome: 'error', reason: 'presence_failed' };
    }

    const passNow = this.now();
    const out = await lightningMatch(this.deps.rpc, {
      clusterId: this.clusterId,
      now: passNow,
      disconnected,
      matcherVersion: this.config.matcherVersion,
      playerPlatforms: this.platformsToSend(platforms),
    });
    this.notePlatformsDelivery(out.platforms);

    if (out.status !== 'ok') this.observeShadow(passNow, snap, 'match', false, null, []);
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
    this.observeShadow(passNow, snap, 'match', true, result.matcherVersion, result.groups);
    return { outcome: 'matched', summary, disconnected: disconnected.length };
  }

  /**
   * LIGHTNING PHASE 11: hand the pass that just RETURNED to the shadow
   * runner. Synchronous, guarded, and nothing is read back.
   */
  private observeShadow(
    passNow: Date,
    snap: LightningPresenceSnapshot,
    kind: 'form' | 'match',
    ok: boolean,
    matcherVersion: string | null,
    groups: readonly LightningDecidedGroup[]
  ): void {
    if (!this.shadow.active) return;
    try {
      this.shadow.observe({
        nowMs: passNow.getTime(),
        presence: {
          connected: snap.connected,
          disconnected: snap.disconnected,
          unknown: snap.unknown,
        },
        kind,
        ok,
        matcherVersion,
        groups,
      });
    } catch (err) {
      if (this.failureLog.shouldLog('shadow')) {
        this.logger.error(
          `[Lightning:${this.clusterId}] shadow runner threw; live play unaffected`,
          err
        );
      }
    }
  }

  /**
   * LIGHTNING PHASE 8: p_player_platforms, unless the database refused the
   * argument recently (old signature still live). Then nothing is sent until
   * the retry time, so a pass costs one call rather than two.
   */
  private platformsToSend(
    platforms: Record<string, LightningDevicePlatform>
  ): Record<string, LightningDevicePlatform> | null {
    if (this.now().getTime() < this.platformsRetryAtMs) return null;
    return Object.keys(platforms).length > 0 ? platforms : null;
  }

  private notePlatformsDelivery(delivery: LightningPlatformsDelivery): void {
    if (delivery === 'dropped') {
      this.platformsRetryAtMs = this.now().getTime() + LIGHTNING_PLATFORMS_RETRY_MS;
      if (this.failureLog.shouldLog('platforms_dropped')) {
        this.logger.warn(
          `[Lightning:${this.clusterId}] the matcher does not take p_player_platforms yet; ` +
            'calling without it (per-platform Cluster limits wait for the migration)'
        );
      }
    } else if (delivery === 'sent') {
      this.platformsRetryAtMs = 0;
    }
  }

  /**
   * A draining pass: no I/O at all. The keepalive line says, at most once per
   * keepalive interval, that the worker is alive and why it is not forming.
   */
  private drainPass(): LightningWorkerPassResult {
    const nowMs = this.now().getTime();
    if (nowMs - this.lastDrainLogAtMs >= this.config.keepaliveIntervalMs) {
      this.lastDrainLogAtMs = nowMs;
      this.logger.log(
        `[Lightning:${this.clusterId}] draining (pending_off): forming nothing until the Cluster is MUST MOVE`
      );
    }
    return { outcome: 'skipped', reason: 'pending_off' };
  }

  /** One forming pass: match_and_form, then a host per formed hand. */
  private async formPass(): Promise<LightningWorkerPassResult> {
    if (this.frozen()) return { outcome: 'frozen' };
    const backoffUntil = this.deps.formBackoffUntil?.() ?? 0;
    if (backoffUntil > this.now().getTime())
      return { outcome: 'skipped', reason: 'abandon_backoff' };
    if (this.deps.holdsFrontTableLease) {
      let held = false;
      try {
        held = await this.deps.holdsFrontTableLease();
      } catch (err) {
        if (this.failureLog.shouldLog('front_table_lease')) {
          this.logger.error(
            `[Lightning:${this.clusterId}] front table lease unknown; not forming`,
            err
          );
        }
      }
      if (!held) return { outcome: 'skipped', reason: 'front_table_lease_not_held' };
    }
    let disconnected: string[];
    let platforms: Record<string, LightningDevicePlatform>;
    let snap: LightningPresenceSnapshot;
    try {
      snap = this.deps.presence.snapshot(this.clusterId, this.knownPoolPlayers);
      disconnected = snap.pDisconnected;
      platforms = snap.platforms ?? {};
    } catch (err) {
      if (this.failureLog.shouldLog('presence')) {
        this.logger.error(`[Lightning:${this.clusterId}] presence feed failed; pass skipped`, err);
      }
      return { outcome: 'error', reason: 'presence_failed' };
    }
    // ONE FORMATION IN FLIGHT PER CLUSTER (Lightning Phase 12): whichever
    // worker object issued it. An id whose outcome is unknown is re-asked.
    const gateNowMs = this.now().getTime();
    const gate = this.gate.check(this.clusterId, gateNowMs);
    if (gate.busy) return { outcome: 'skipped', reason: 'formation_in_flight' };
    const retryId = this.pendingRequestId ?? gate.pendingRequestId;
    const requestId = retryId ?? randomUUID();
    this.pendingRequestId = requestId;
    const passNow = this.now();
    this.gate.open(this.clusterId, requestId, gateNowMs);
    const out = await this.formCall({
      clusterId: this.clusterId,
      now: passNow,
      disconnected,
      maxHands: this.config.maxHandsPerPass,
      requestId,
      playerPlatforms: this.platformsToSend(platforms),
    });
    this.notePlatformsDelivery(out.platforms);
    if (out.status !== 'ok') this.observeShadow(passNow, snap, 'form', false, null, []);
    if (out.status === 'error') {
      // Unknown outcome: the next pass asks again under the same id.
      if (out.timedOut !== true) this.gate.close(this.clusterId, requestId, true, this.nowMs());
      if (this.failureLog.shouldLog('form_error')) {
        this.logger.error(
          `[Lightning:${this.clusterId}] fn_lightning_match_and_form failed`,
          out.error
        );
      }
      return { outcome: 'error', reason: out.timedOut === true ? 'rpc_timeout' : 'rpc_failed' };
    }
    // A worker stopped while its call was out still hands what the call
    // formed to the dealing host: the host deals it, or - on a leadership loss
    // or shutdown - the supervisor's abort voids it cleanly right after this
    // pass returns. Nothing formed is ever left without an owner.
    // A pass the database skipped (`pass_in_progress`) did not run under this
    // id: when it was a RETRY, the earlier attempt's outcome is still unknown.
    const skippedRetry =
      retryId !== null &&
      out.status === 'ok' &&
      (out.value as Record<string, unknown>).skipped === true &&
      (out.value as Record<string, unknown>).replayed !== true;
    this.gate.close(this.clusterId, requestId, skippedRetry, this.nowMs());
    if (!skippedRetry) this.pendingRequestId = null;
    if (out.status === 'unavailable') {
      if (this.failureLog.shouldLog('unavailable')) {
        this.logger.warn(
          `[Lightning:${this.clusterId}] fn_lightning_match_and_form is not deployed yet`
        );
      }
      return { outcome: 'unavailable', reason: out.reason };
    }
    if (out.status === 'invalid') return { outcome: 'invalid', reason: out.reason };
    const result = out.value;
    if (result.skipped === true) return { outcome: 'skipped', reason: String(result.reason ?? '') };
    if (result.ok !== true && result.frozen !== true && result.reason) {
      return { outcome: 'invalid', reason: String(result.reason) };
    }
    const formedAtMs = this.now().getTime();
    const hands = Array.isArray(result.hands) ? result.hands : [];
    let started = 0;
    const decided: LightningDecidedGroup[] = [];
    for (const raw of hands) {
      const h = raw as Record<string, unknown>;
      const players = Array.isArray(h.players) ? h.players.filter(isUuid) : [];
      if (
        !isUuid(h.hand_id) ||
        !isUuid(h.instance_id) ||
        !isUuid(h.bb) ||
        !isUuid(h.sb) ||
        !isUuid(h.btn) ||
        players.length < 2
      ) {
        this.logger.error(
          `[Lightning:${this.clusterId}] formed hand outside its contract; left to the reaper`
        );
        continue;
      }
      if (this.deps.hasInstance?.(h.instance_id)) continue; // a replay naming a hand already dealt
      this.metrics.noteMatched(players, formedAtMs, this.clusterId);
      decided.push({ players, bb: h.bb, sb: h.sb, btn: h.btn });
      for (const p of players)
        if (!this.knownPoolPlayers.includes(p)) this.knownPoolPlayers.push(p);
      this.deps.startHand!({
        clusterId: this.clusterId,
        instanceId: h.instance_id,
        handId: h.hand_id,
        bb: h.bb,
        sb: h.sb,
        btn: h.btn,
        players,
        formedAtMs,
      });
      started++;
    }
    this.observeShadow(
      passNow,
      snap,
      'form',
      result.ok === true && result.frozen !== true,
      typeof result.matcher_version === 'string' ? result.matcher_version : null,
      decided
    );
    if (result.frozen === true || result.stopped_reason === 'frozen') {
      this.logger.error(
        `[Lightning:${this.clusterId}] formation_invariant_failed: the barrier froze the Cluster; worker stopping`
      );
      this.stopped = true;
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.deps.onClusterFrozen?.(this.clusterId);
      return { outcome: 'frozen', reason: 'formation_invariant_failed', formed: started };
    }
    const saturated =
      started > 0 && SATURATED_STOP_REASONS.has(String(result.stopped_reason ?? ''));
    return saturated
      ? { outcome: 'formed', formed: started, saturated: true }
      : { outcome: 'formed', formed: started };
  }

  private nowMs(): number {
    return this.now().getTime();
  }

  /**
   * The forming call, bounded: an answer later than formTimeoutMs is treated
   * as outcome-unknown (the pass returns, the worker keeps its clock). The
   * late answer, whatever it is, is acted on by nobody, so its id stays with
   * the gate to be re-asked, and the gate stays held until it lands.
   */
  private async formCall(
    args: Parameters<typeof lightningMatchAndForm>[1]
  ): Promise<Awaited<ReturnType<typeof lightningMatchAndForm>> & { timedOut?: boolean }> {
    const call = lightningMatchAndForm(this.deps.rpc, args);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.formTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const first = await Promise.race([call, timeout]);
    if (timer) clearTimeout(timer);
    if (first !== 'timeout') return first;
    void call.then(
      () => this.gate.close(this.clusterId, args.requestId, true, this.nowMs()),
      () => this.gate.close(this.clusterId, args.requestId, true, this.nowMs())
    );
    return {
      status: 'error',
      error: new Error(`fn_lightning_match_and_form unanswered after ${this.formTimeoutMs}ms`),
      platforms: 'none',
      timedOut: true,
    };
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
