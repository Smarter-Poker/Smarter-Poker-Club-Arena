/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SHADOW MATCHER RUNNER (Lightning Phase 11, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Spec "MATCHER SHADOW MODE": the real population goes to the current
 * matcher AND to a shadow matcher; the shadow never controls live seating;
 * formation success, wait time, BB fairness, position fairness, opponent
 * diversity, instance occupancy and failure rate are compared, and each
 * comparison records both matcher versions.
 *
 * ONE RUNNER PER CLUSTER WORKER. After every live pass the worker hands this
 * runner what that pass saw (its presence snapshot and its `now`) and what
 * the live matcher decided (the hands it formed, or in worker 'shadow' mode
 * the groups fn_lightning_match planned). The runner then, synchronously and
 * inside a try/catch the worker owns:
 *
 *   1. builds the POPULATION SNAPSHOT - a fresh object, the engine's own view
 *      of the Cluster's open pool (who the anchor engines report, connected
 *      or not, minus whoever this process has in a hand), with the queue
 *      keys the SQL plan reads, learned from the hands this process formed;
 *   2. runs the SHADOW MATCHER on it (LightningMatcherModel, by version):
 *      a pure function - no RPC, no reservation, no seat, no hand;
 *   3. scores BOTH decisions against that same snapshot and adds them to the
 *      window;
 *   4. only then applies the LIVE outcome to its model (the shadow's
 *      decisions are never applied: it does not get to rewrite history).
 *
 * The live pass has already returned by the time any of this runs, its
 * hands are already with their hosts, and nothing here is read back by the
 * worker: the shadow has no path to the live decision, its timing or its
 * payloads.
 *
 * ONE RECORD PER WINDOW. Windows are aligned to the wall clock
 * (`shadow_window_ms`, five minutes by default). When a pass lands past the
 * window's end, the window closes: one `fn_lightning_shadow_record` call for
 * the Cluster and, when integrity telemetry is on, one
 * `fn_lightning_integrity_report` - off the pass's path (fire and forget,
 * one flush in flight at a time; a window that closes while one is in
 * flight is dropped and counted, never queued without bound).
 *
 * NOT YET DEPLOYED IS NOT A FAULT. "Function not found" marks that function
 * unavailable for ten minutes (the presence reporter's pattern): its windows
 * are dropped quietly, nothing retries in a loop, and live play never knew.
 *
 * CPU BOUND. A snapshot larger than `shadow_max_players` is not planned
 * (skipped_size). A shadow pass that takes longer than
 * `shadow_pass_budget_ms` makes the next passes skip (skipped_overrun),
 * proportionally to the overrun, capped at ten passes.
 *
 * OFF IS ZERO WORK. With both flags off the runner is unregistered from the
 * telemetry intake, holds no state, and `observe` returns at its first line.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5): nothing here knows who is one.
 *
 * PHASE 11 REMEDIATION (2026-10-09), so the comparison is not biased toward
 * either side:
 *
 *   - A PASS WHOSE LIVE CALL FAILED IS NOT SCORED on either side (a database
 *     outage is not the live matcher's failure, and the shadow is not
 *     credited for planning through it); it is counted as
 *     `skipped.live_failed`.
 *   - A PASS THE SHADOW SKIPS (size cap, overrun, unknown version) is not
 *     scored on the live side either: both sides are scored on exactly the
 *     same passes. The size cap is checked on the presence BEFORE any
 *     snapshot is built, so an oversized pool costs nothing.
 *   - `bb_fairness.order_violations` is sent as null on BOTH sides: the
 *     shadow's big blinds are the top of its own order by construction, the
 *     live side's come from the database's P2 ranks this snapshot does not
 *     carry, so the count could only ever charge the live side. It returns
 *     when the snapshot carries the database's P2 ranks.
 *   - The live outcome enters the model as the barrier wrote it: each group
 *     of a pass its own microsecond (`v_now + (ordinal - 1) us`) for the big
 *     blind's last_bb_at and the hand's formed_at, the heads-up small blind
 *     on the button, and each hand under its id and epoch.
 *   - P5's band reads the database's legal count for the pass when the live
 *     answer gave one; in worker 'shadow' mode the diagnosis gives every
 *     player's legality exactly.
 */
import {
  lightningMatcherModel,
  compareBlindOrder,
  recentWindow,
  encounterMemory,
  type LightningMatcherParams,
  type LightningPoolPlayer,
  type LightningPoolSnapshot,
  type LightningRecentHand,
} from './LightningMatcherModel.js';
import {
  LIGHTNING_FAILURE_LOG_INTERVAL_MS,
  type LightningShadowConfig,
} from './LightningConfig.js';
import {
  lightningIntegrityReport,
  lightningShadowRecord,
  type LightningRpcClient,
  type LightningRpcOutcome,
} from './LightningRpc.js';
import {
  BoundedSample,
  lightningTelemetry,
  round1,
  round4,
  type LightningClusterTelemetrySink,
  type LightningTelemetry,
} from './LightningTelemetry.js';
import { LightningIntegrityWindow } from './LightningIntegrity.js';
import { LIGHTNING_LATENCY_SEGMENTS, type LightningLatencySegment } from './LightningMetrics.js';
import { RateLimitedLog } from './RateLimitedLog.js';
import type { LightningWorkerLogger } from './LightningClusterWorker.js';

/** After "function not found" (deploy window), that function is not called for this long. */
export const LIGHTNING_SHADOW_RPC_RETRY_MS = 10 * 60_000;
/** Most passes an overrun can make the shadow skip. */
export const LIGHTNING_SHADOW_MAX_SKIP_PASSES = 10;
/** Players the engine's pool model remembers (the least recently seen go first). */
export const LIGHTNING_SHADOW_MODEL_MAX_PLAYERS = 10_000;
/** A player unseen this long is forgotten by the pool model. */
export const LIGHTNING_SHADOW_MODEL_FORGET_MS = 30 * 60_000;
/** Recent hands the pool model keeps (P5's window is at most this). */
export const LIGHTNING_SHADOW_MODEL_MAX_HANDS = 500;
/**
 * A player the model has in a hand for longer than this is taken to be free
 * again: a release this process never heard about must not hide them from
 * the shadow's population for good.
 */
export const LIGHTNING_SHADOW_IN_HAND_MAX_MS = 10 * 60_000;
/** Samples per window per measure (waits, latency legs). */
export const LIGHTNING_SHADOW_SAMPLE_CAP = 2_048;

/** One group a matcher decided (live or shadow). sb/btn are optional for a plan-only group. */
export interface LightningDecidedGroup {
  players: readonly string[];
  bb: string;
  sb?: string | null;
  btn?: string | null;
  /** The formed hand's id (live 'form' passes): P5's window tie-break. */
  handId?: string | null;
}

/** What one live pass saw and decided, as the worker hands it over. */
export interface LightningLivePassObservation {
  /** The pass's own `now` (the one its RPC was given). */
  nowMs: number;
  /** The presence snapshot the pass read. */
  presence: {
    connected: readonly string[];
    disconnected: readonly string[];
    unknown?: readonly string[];
  };
  /** 'form': these hands were formed; 'match': fn_lightning_match planned these groups. */
  kind: 'form' | 'match';
  /** False when the live pass failed (error, invalid, unavailable, frozen, refused). */
  ok: boolean;
  /** The live matcher's version as the database reported it, when it did. */
  matcherVersion: string | null;
  groups: readonly LightningDecidedGroup[];
  /** The Cluster epoch the live answer named (match_and_form's cluster_epoch), when it did. */
  epoch?: number | null;
  /** The database's legal count for the pass (the live answer's legal_count), when it gave one. */
  legalCount?: number | null;
  /**
   * Worker 'shadow' mode: fn_lightning_match's diagnosis, by player - null
   * for a legal player, else the reason code. A presence player it does not
   * name is not in the database's open pool.
   */
  legality?: ReadonlyMap<string, string | null> | null;
}

export interface LightningShadowRunnerDeps {
  rpc: LightningRpcClient;
  telemetry?: LightningTelemetry;
  logger?: LightningWorkerLogger;
  /** Wall clock for the shadow pass budget (performance.now in production). */
  clock?: () => number;
  /** Wall clock for the record's p_now. */
  now?: () => Date;
}

interface ModelPlayer {
  enteredAtMs: number;
  idleSinceMs: number;
  lastBbAtMs: number | null;
  handsSinceBb: number | null;
  positions: { btn: number; co: number; hj: number; utg: number };
  inHand: boolean;
  inHandSinceMs: number;
  seenInHand: boolean;
  lastSeenMs: number;
}

/** One side's (live or shadow) accumulators for the window. */
class SideWindow {
  passes = 0;
  quorumPasses = 0;
  successPasses = 0;
  failedPasses = 0;
  groups = 0;
  seated = 0;
  sizeSum = 0;
  waits = new BoundedSample(LIGHTNING_SHADOW_SAMPLE_CAP, 0x51ed);
  bbGaps = new BoundedSample(LIGHTNING_SHADOW_SAMPLE_CAP, 0xbb);
  bbGapMax: number | null = null;
  bbOrderViolations = 0;
  btnCountSum = 0;
  btnN = 0;
  pairs = 0;
  repeatPairs = 0;
  /** The matcher version this side last ran (one name: the DB's version rule has no lists). */
  lastVersion: string | null = null;

  json(instanceMax: number): Record<string, unknown> {
    const wait = this.waits.summary();
    const gaps = this.bbGaps.summary();
    return {
      passes: this.passes,
      quorum_passes: this.quorumPasses,
      formation_success_rate:
        this.quorumPasses === 0 ? null : round4(this.successPasses / this.quorumPasses),
      failed_passes: this.failedPasses,
      failure_rate: this.passes === 0 ? null : round4(this.failedPasses / this.passes),
      groups: this.groups,
      seated: this.seated,
      wait_ms: wait,
      bb_fairness: {
        n: gaps.n,
        avg_hands_since_bb: gaps.avg,
        p95_hands_since_bb: gaps.p95,
        max_hands_since_bb: this.bbGapMax,
        // Null on BOTH sides until the snapshot carries the database's P2
        // ranks (see the header): a count only the live side can incur.
        order_violations: null,
      },
      position_fairness: {
        btn_n: this.btnN,
        btn_avg_count_before: this.btnN === 0 ? null : round4(this.btnCountSum / this.btnN),
      },
      opponent_diversity: {
        pairs: this.pairs,
        repeat_pairs: this.repeatPairs,
        repeat_pair_rate: this.pairs === 0 ? null : round4(this.repeatPairs / this.pairs),
      },
      instance_occupancy: {
        avg_size: this.groups === 0 ? null : round4(this.sizeSum / this.groups),
        // 0..1 (the DB refuses more): a live group can only exceed the
        // configured maximum if the config changed under it.
        utilization:
          this.groups === 0 ? null : round4(Math.min(1, this.sizeSum / this.groups / instanceMax)),
      },
    };
  }
}

/** A decision scored against the snapshot both sides saw. */
export interface LightningDecisionScore {
  legal: number;
  quorum: boolean;
  groups: number;
  seated: number;
  sizes: number[];
  waits: number[];
  bbGaps: number[];
  bbOrderViolations: number;
  btnCounts: number[];
  pairs: number;
  repeatPairs: number;
}

/**
 * Score one decision against a snapshot. Pure. Players a group names that
 * the snapshot does not know (e.g. seen by another process) count toward
 * seating and pairs but carry no wait or queue keys.
 */
export function scoreLightningDecision(
  snapshot: LightningPoolSnapshot,
  params: LightningMatcherParams,
  groups: readonly LightningDecidedGroup[]
): LightningDecisionScore {
  const byId = new Map(snapshot.players.map((p) => [p.playerId, p]));
  const legal = snapshot.players.filter((p) => p.legal).sort(compareBlindOrder);
  const seatedIds = new Set<string>();
  for (const g of groups) for (const p of g.players) seatedIds.add(p);
  const { encounters } = encounterMemory(recentWindow(snapshot, params), seatedIds);
  const topBbs = new Set(legal.slice(0, groups.length).map((p) => p.playerId));
  const legalCount =
    typeof snapshot.legalCount === 'number' && Number.isFinite(snapshot.legalCount)
      ? snapshot.legalCount
      : legal.length;
  const out: LightningDecisionScore = {
    legal: legalCount,
    quorum: legalCount >= params.instanceMin,
    groups: groups.length,
    seated: 0,
    sizes: [],
    waits: [],
    bbGaps: [],
    bbOrderViolations: 0,
    btnCounts: [],
    pairs: 0,
    repeatPairs: 0,
  };
  for (const g of groups) {
    const members = [...new Set(g.players)];
    out.seated += members.length;
    out.sizes.push(members.length);
    for (const id of members) {
      const p = byId.get(id);
      if (p) out.waits.push(Math.max(0, snapshot.nowMs - p.idleSinceMs));
    }
    const bb = byId.get(g.bb);
    if (bb && bb.handsSinceBb !== null) out.bbGaps.push(bb.handsSinceBb);
    if (bb && !topBbs.has(g.bb)) out.bbOrderViolations++;
    const btnId =
      g.btn ?? (members.length > 2 ? members[members.length - 1] : (g.sb ?? members[1]));
    const btn = btnId ? byId.get(btnId) : undefined;
    if (btn) out.btnCounts.push(btn.positions.btn);
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        out.pairs++;
        const k =
          members[i] < members[j] ? `${members[i]}/${members[j]}` : `${members[j]}/${members[i]}`;
        if ((encounters.get(k) ?? 0) > 0) out.repeatPairs++;
      }
  }
  return out;
}

/** A recent hand, copied (the shadow plans on its own copy). */
function copyHand(h: LightningRecentHand): LightningRecentHand {
  return { ...h, players: [...h.players] };
}

/**
 * The barrier's stamp for group `ordinal` (0-based) of a pass at `nowMs`:
 * one microsecond per group (fn_lightning_match_and_form's v_group_now).
 */
export function lightningGroupStampMs(nowMs: number, ordinal: number): number {
  return nowMs + ordinal / 1000;
}

function addScore(side: SideWindow, s: LightningDecisionScore, ok: boolean): void {
  side.passes++;
  if (!ok) side.failedPasses++;
  if (s.quorum) side.quorumPasses++;
  if (s.quorum && s.groups > 0) side.successPasses++;
  side.groups += s.groups;
  side.seated += s.seated;
  for (const x of s.sizes) side.sizeSum += x;
  for (const w of s.waits) side.waits.add(w);
  for (const gap of s.bbGaps) {
    side.bbGaps.add(gap);
    side.bbGapMax = side.bbGapMax === null ? gap : Math.max(side.bbGapMax, gap);
  }
  side.bbOrderViolations += s.bbOrderViolations;
  for (const c of s.btnCounts) {
    side.btnCountSum += c;
    side.btnN++;
  }
  side.pairs += s.pairs;
  side.repeatPairs += s.repeatPairs;
}

const consoleLogger: LightningWorkerLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ''),
};

type FnKey = 'shadow_record' | 'integrity_report';

export class LightningShadowRunner implements LightningClusterTelemetrySink {
  private config: LightningShadowConfig | null = null;
  private readonly telemetry: LightningTelemetry;
  private readonly logger: LightningWorkerLogger;
  private readonly clock: () => number;
  private readonly now: () => Date;
  private readonly failureLog = new RateLimitedLog(LIGHTNING_FAILURE_LOG_INTERVAL_MS, 8);
  private registered = false;
  private stopped = false;

  // The engine's pool model (shadow only).
  private model = new Map<string, ModelPlayer>();
  private recentHands: LightningRecentHand[] = [];

  // The current window.
  private windowStartMs: number | null = null;
  private live = new SideWindow();
  private shadow = new SideWindow();
  private latencies = new Map<LightningLatencySegment, BoundedSample>();
  private integrity = new LightningIntegrityWindow();
  private skipSize = 0;
  private skipOverrun = 0;
  private skipUnknownVersion = 0;
  private skipLiveFailed = 0;
  private shadowMsTotal = 0;
  private shadowRuns = 0;
  private skipNext = 0;
  private droppedWindows = 0;

  private readonly unavailableUntil: Record<FnKey, number> = {
    shadow_record: 0,
    integrity_report: 0,
  };
  private flushing: Promise<void> | null = null;
  private records = 0;

  constructor(
    readonly clusterId: string,
    private readonly deps: LightningShadowRunnerDeps
  ) {
    this.telemetry = deps.telemetry ?? lightningTelemetry;
    this.logger = deps.logger ?? consoleLogger;
    this.clock = deps.clock ?? (() => performance.now());
    this.now = deps.now ?? (() => new Date());
  }

  /** Is anything on? (Off is zero work.) */
  get active(): boolean {
    return !this.stopped && !!this.config && (this.config.enabled || this.config.integrityEnabled);
  }

  /** Records and reports sent (successfully answered calls), for tests and logs. */
  get recordsSent(): number {
    return this.records;
  }

  /** The current config; switching both flags off drops every bit of state. */
  configure(config: LightningShadowConfig | undefined): void {
    if (this.stopped) return;
    const prev = this.config;
    this.config = config && (config.enabled || config.integrityEnabled) ? config : null;
    if (!this.config) {
      if (this.registered) this.telemetry.unregister(this.clusterId, this);
      this.registered = false;
      if (prev) this.resetAll();
      return;
    }
    if (!this.registered) {
      this.telemetry.register(this.clusterId, this);
      this.registered = true;
    }
    if (prev && prev.windowMs !== this.config.windowMs) this.windowStartMs = null;
  }

  /**
   * One live pass, after it returned. Synchronous; never throws (the
   * worker also wraps it); never awaited by the pass.
   */
  observe(pass: LightningLivePassObservation): void {
    const cfg = this.config;
    if (!cfg || this.stopped) return;
    try {
      this.rollWindow(pass.nowMs, cfg);
      if (cfg.enabled) this.shadowPass(pass, cfg);
    } catch (err) {
      if (this.failureLog.shouldLog('observe')) {
        this.logger.error(
          `[LightningShadow:${this.clusterId}] shadow pass failed; live play unaffected`,
          err
        );
      }
    }
  }

  /**
   * Stop: unregister, flush the open window once (bounded by the worker's
   * drain). A flush already in flight is awaited FIRST: closing the final
   * window while it ran would drop that window (one flush in flight).
   * A restart inside an aligned window reports [start, stop) here and the
   * next process reports [start, end): two rows that overlap, keyed apart by
   * window_to - accepted, and documented in the changelog.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    // No pass is observed from here on; the telemetry sink may still add.
    this.stopped = true;
    if (this.flushing) await this.flushing.catch(() => undefined);
    const cfg = this.config;
    if (cfg && this.windowStartMs !== null) {
      try {
        this.closeWindow(
          this.windowStartMs,
          Math.max(this.windowStartMs + 1, this.now().getTime()),
          cfg
        );
      } catch {
        // nothing to flush
      }
    }
    if (this.registered) this.telemetry.unregister(this.clusterId, this);
    this.registered = false;
    if (this.flushing) await this.flushing.catch(() => undefined);
    this.resetAll();
  }

  /** Resolves when the flush in flight (if any) has finished. For tests. */
  async settled(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => undefined);
  }

  // ─── TELEMETRY SINK (called by LightningTelemetry; cheap, never throws) ─

  latency(segment: LightningLatencySegment, ms: number): void {
    if (!this.config?.enabled) return;
    let s = this.latencies.get(segment);
    if (!s) {
      s = new BoundedSample(512, 0x1a7 + segment.length);
      this.latencies.set(segment, s);
    }
    s.add(ms);
  }

  idle(playerId: string, atMs: number): void {
    if (!this.config?.enabled) return;
    const p = this.model.get(playerId);
    if (!p) return;
    p.inHand = false;
    p.idleSinceMs = atMs;
    p.lastSeenMs = Math.max(p.lastSeenMs, atMs);
  }

  handDealt(handId: string, players: readonly string[]): void {
    if (this.config?.integrityEnabled) this.integrity.handDealt(handId, players);
  }

  decision(handId: string, playerId: string, latencyMs: number): void {
    if (this.config?.integrityEnabled) this.integrity.decision(handId, playerId, latencyMs);
  }

  timeout(handId: string, playerId: string): void {
    if (this.config?.integrityEnabled) this.integrity.timeout(handId, playerId);
  }

  handEnded(handId: string): void {
    if (this.config?.integrityEnabled) this.integrity.handEnded(handId);
  }

  // ─── THE SHADOW PASS ────────────────────────────────────────────────────

  /** The population snapshot this pass saw: a fresh object every time. */
  buildSnapshot(pass: LightningLivePassObservation): LightningPoolSnapshot {
    const nowMs = pass.nowMs;
    const players: LightningPoolPlayer[] = [];
    const seen = new Set<string>();
    const diagnosed = pass.legality ?? null;
    const add = (id: string, connected: boolean): void => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      let m = this.model.get(id);
      if (!m) {
        m = {
          enteredAtMs: nowMs,
          idleSinceMs: nowMs,
          lastBbAtMs: null,
          handsSinceBb: null,
          positions: { btn: 0, co: 0, hj: 0, utg: 0 },
          inHand: false,
          inHandSinceMs: 0,
          seenInHand: false,
          lastSeenMs: nowMs,
        };
        this.model.set(id, m);
      }
      m.lastSeenMs = nowMs;
      // A player this process has in a hand is not in the open pool.
      if (m.inHand && nowMs - m.inHandSinceMs < LIGHTNING_SHADOW_IN_HAND_MAX_MS) return;
      if (m.inHand) {
        m.inHand = false;
        m.idleSinceMs = nowMs;
      }
      // Legality: the database's own answer when the pass carried one
      // (worker 'shadow' mode), else connected and not in a hand here.
      let legal = connected;
      let reasonCode: string | null = connected ? null : 'DISCONNECTED';
      if (diagnosed) {
        if (diagnosed.has(id)) {
          reasonCode = diagnosed.get(id) ?? null;
          legal = reasonCode === null;
        } else {
          legal = false;
          reasonCode = 'NOT_IN_POOL';
        }
      }
      players.push({
        playerId: id,
        legal,
        reasonCode,
        idleSinceMs: m.idleSinceMs,
        enteredAtMs: m.enteredAtMs,
        // The engine sees one moment per player (its first sighting) for the
        // pool entry, the slot's opening and the Cluster join alike.
        joinedAtMs: m.enteredAtMs,
        slotOpenedAtMs: m.enteredAtMs,
        lastBbAtMs: m.lastBbAtMs,
        bbUnresolved: false,
        debtSinceMs: m.enteredAtMs,
        handsSinceBb: m.handsSinceBb,
        newcomer: !m.seenInHand,
        positions: { ...m.positions },
      });
    };
    for (const id of pass.presence.connected) add(id, true);
    for (const id of pass.presence.disconnected) add(id, false);
    for (const id of pass.presence.unknown ?? []) add(id, false);
    return {
      nowMs,
      players,
      recentHands: this.recentHands.map(copyHand),
      ...(typeof pass.epoch === 'number' ? { epoch: pass.epoch } : {}),
      ...(typeof pass.legalCount === 'number' && !diagnosed ? { legalCount: pass.legalCount } : {}),
    };
  }

  private shadowPass(pass: LightningLivePassObservation, cfg: LightningShadowConfig): void {
    // A FAILED LIVE CALL SCORES NEITHER SIDE (and teaches the model nothing).
    if (!pass.ok) {
      this.skipLiveFailed++;
      this.forgetStale(pass.nowMs);
      return;
    }
    if (pass.matcherVersion) this.live.lastVersion = pass.matcherVersion;
    const params = cfg.params;
    const model = lightningMatcherModel(cfg.version);
    // A PASS THE SHADOW SKIPS IS NOT SCORED ON THE LIVE SIDE EITHER, and is
    // decided before any snapshot is built (the size cap reads the presence).
    const presenceSize =
      pass.presence.connected.length +
      pass.presence.disconnected.length +
      (pass.presence.unknown?.length ?? 0);
    let skipped = true;
    if (!model) {
      this.skipUnknownVersion++;
      if (this.failureLog.shouldLog('unknown_version')) {
        this.logger.warn(
          `[LightningShadow:${this.clusterId}] shadow_matcher_version '${cfg.version}' is not a matcher this engine models; shadow side idle`
        );
      }
    } else if (presenceSize > cfg.maxPlayers) {
      this.skipSize++;
    } else if (this.skipNext > 0) {
      this.skipNext--;
      this.skipOverrun++;
    } else {
      skipped = false;
    }
    if (model && !skipped) {
      const snapshot = this.buildSnapshot(pass);
      addScore(this.live, scoreLightningDecision(snapshot, params, pass.groups), true);
      // The shadow plans on its OWN copy: nothing it does can reach the model.
      const copy: LightningPoolSnapshot = {
        ...snapshot,
        players: snapshot.players.map((p) => ({ ...p, positions: { ...p.positions } })),
        recentHands: snapshot.recentHands.map(copyHand),
      };
      const started = this.clock();
      let ok = true;
      let groups: LightningDecidedGroup[] = [];
      try {
        groups = model.plan(copy, params).groups;
      } catch (err) {
        ok = false;
        if (this.failureLog.shouldLog('shadow_plan')) {
          this.logger.error(
            `[LightningShadow:${this.clusterId}] shadow matcher ${model.version} threw`,
            err
          );
        }
      }
      const took = this.clock() - started;
      this.shadowMsTotal += took;
      this.shadowRuns++;
      if (took > cfg.passBudgetMs) {
        this.skipNext = Math.min(
          LIGHTNING_SHADOW_MAX_SKIP_PASSES,
          Math.ceil(took / cfg.passBudgetMs) - 1
        );
      }
      addScore(this.shadow, scoreLightningDecision(snapshot, params, groups), ok);
      this.shadow.lastVersion = model.version;
    }

    // Only now does the LIVE outcome enter the model: hands formed are history.
    if (pass.kind === 'form') this.applyLive(pass);
    this.forgetStale(pass.nowMs);
  }

  /**
   * The live outcome, as the barrier wrote it: group k of the pass (0-based,
   * in the order the database formed them) is stamped `now + k us` - its big
   * blind's last_bb_at and the hand's formed_at - exactly as
   * fn_lightning_match_and_form stamps `v_now + (ordinal - 1) * 1 microsecond`.
   * (The database counts a group it attempted and could not form; the engine
   * sees only the formed ones, which keeps their order and so the order P2
   * reads.)
   */
  private applyLive(pass: LightningLivePassObservation): void {
    for (const [ordinal, g] of pass.groups.entries()) {
      const members = [...g.players];
      const size = members.length;
      const stampMs = lightningGroupStampMs(pass.nowMs, ordinal);
      for (let i = 0; i < size; i++) {
        const id = members[i];
        let m = this.model.get(id);
        if (!m) {
          m = {
            enteredAtMs: pass.nowMs,
            idleSinceMs: pass.nowMs,
            lastBbAtMs: null,
            handsSinceBb: null,
            positions: { btn: 0, co: 0, hj: 0, utg: 0 },
            inHand: false,
            inHandSinceMs: 0,
            seenInHand: false,
            lastSeenMs: pass.nowMs,
          };
          this.model.set(id, m);
        }
        m.inHand = true;
        m.inHandSinceMs = pass.nowMs;
        m.seenInHand = true;
        if (id === g.bb) {
          m.lastBbAtMs = stampMs;
          m.handsSinceBb = 0;
        } else if (m.handsSinceBb !== null) {
          m.handsSinceBb++;
        }
        // The matcher order: bb, sb, seat 3 (utg) onward, the button last -
        // the barrier's own position names (heads-up, the small blind is the
        // button and its btn_count moves).
        if (size === 2) {
          if (i === 1) m.positions.btn++;
        } else if (i === size - 1) m.positions.btn++;
        else if (i === size - 2 && size >= 4) m.positions.co++;
        else if (i === size - 3 && size >= 5) m.positions.hj++;
        else if (i === 2) m.positions.utg++;
      }
      this.recentHands.push({
        players: members,
        formedAtMs: stampMs,
        ...(typeof g.handId === 'string' ? { handId: g.handId } : {}),
        ...(typeof pass.epoch === 'number' ? { epoch: pass.epoch } : {}),
      });
    }
    if (this.recentHands.length > LIGHTNING_SHADOW_MODEL_MAX_HANDS) {
      this.recentHands.splice(0, this.recentHands.length - LIGHTNING_SHADOW_MODEL_MAX_HANDS);
    }
  }

  private forgetStale(nowMs: number): void {
    if (this.model.size <= LIGHTNING_SHADOW_MODEL_MAX_PLAYERS / 2) return;
    for (const [id, m] of this.model) {
      if (!m.inHand && nowMs - m.lastSeenMs >= LIGHTNING_SHADOW_MODEL_FORGET_MS)
        this.model.delete(id);
    }
    // Still over the cap: the least recently inserted go first.
    for (const id of this.model.keys()) {
      if (this.model.size <= LIGHTNING_SHADOW_MODEL_MAX_PLAYERS) break;
      this.model.delete(id);
    }
  }

  // ─── WINDOWS AND FLUSHES ────────────────────────────────────────────────

  private rollWindow(nowMs: number, cfg: LightningShadowConfig): void {
    const start = Math.floor(nowMs / cfg.windowMs) * cfg.windowMs;
    if (this.windowStartMs === null) {
      this.windowStartMs = start;
      return;
    }
    if (start <= this.windowStartMs) return;
    this.closeWindow(this.windowStartMs, this.windowStartMs + cfg.windowMs, cfg);
    this.windowStartMs = start;
  }

  /** Build the window's payloads, reset the accumulators, send off the pass's path. */
  private closeWindow(fromMs: number, toMs: number, cfg: LightningShadowConfig): void {
    // A window is recorded when anything was observed: scored passes, or
    // passes skipped (the skip counters are the evidence the shadow idled).
    const observed =
      this.live.passes > 0 ||
      this.shadow.passes > 0 ||
      this.skipSize + this.skipOverrun + this.skipUnknownVersion + this.skipLiveFailed > 0;
    const shadowPayload = cfg.enabled && observed ? this.shadowPayloads(cfg) : null;
    const signals =
      cfg.integrityEnabled && !this.integrity.isEmpty
        ? {
            ...this.integrity.signals(),
            window_from: new Date(fromMs).toISOString(),
            window_to: new Date(toMs).toISOString(),
          }
        : null;
    this.resetWindow();
    if (!shadowPayload && !signals) return;
    if (this.flushing) {
      this.droppedWindows++;
      if (this.failureLog.shouldLog('window_dropped')) {
        this.logger.warn(
          `[LightningShadow:${this.clusterId}] previous flush still in flight; window dropped`
        );
      }
      return;
    }
    const run = this.flush(fromMs, toMs, cfg, shadowPayload, signals).finally(() => {
      if (this.flushing === run) this.flushing = null;
    });
    this.flushing = run;
  }

  private shadowPayloads(cfg: LightningShadowConfig): {
    liveVersion: string | null;
    shadowVersion: string;
    live: Record<string, unknown>;
    shadow: Record<string, unknown>;
  } {
    const max = Math.max(2, cfg.params.instanceMax);
    const latency: Record<string, unknown> = {};
    for (const seg of LIGHTNING_LATENCY_SEGMENTS) {
      const s = this.latencies.get(seg);
      if (s && s.count > 0) {
        const { n, p50, p95 } = s.summary();
        latency[seg] = { n, p50, p95 };
      }
    }
    const liveVersion = this.live.lastVersion;
    return {
      liveVersion,
      shadowVersion: cfg.version,
      live: {
        ...this.live.json(max),
        matcher_version: liveVersion,
        latency_ms: latency,
        // Hand creation -> first client render (Lightning Phase 12): measured on
        // the engine's clock, from the hand's first frame to the room's RENDER_ACK.
        first_render_measured: true,
      },
      shadow: {
        ...this.shadow.json(max),
        matcher_version: cfg.version,
        skipped: {
          size_cap: this.skipSize,
          overrun: this.skipOverrun,
          unknown_version: this.skipUnknownVersion,
          live_failed: this.skipLiveFailed,
        },
        avg_pass_ms: this.shadowRuns === 0 ? null : round1(this.shadowMsTotal / this.shadowRuns),
        dropped_windows: this.droppedWindows,
      },
    };
  }

  private async flush(
    fromMs: number,
    toMs: number,
    cfg: LightningShadowConfig,
    shadowPayload: ReturnType<LightningShadowRunner['shadowPayloads']> | null,
    signals: Record<string, unknown> | null
  ): Promise<void> {
    if (shadowPayload && shadowPayload.liveVersion === shadowPayload.shadowVersion) {
      // A version compared with itself says nothing (the DB refuses SAME_VERSION).
      if (this.failureLog.shouldLog('same_version')) {
        this.logger.warn(
          `[LightningShadow:${this.clusterId}] shadow_matcher_version equals the live matcher (${shadowPayload.shadowVersion}); no record`
        );
      }
    } else if (shadowPayload && this.available('shadow_record')) {
      const out = await lightningShadowRecord(this.deps.rpc, {
        clusterId: this.clusterId,
        liveVersion: shadowPayload.liveVersion,
        shadowVersion: shadowPayload.shadowVersion,
        windowFrom: new Date(fromMs),
        windowTo: new Date(toMs),
        live: shadowPayload.live,
        shadow: shadowPayload.shadow,
      }).catch((error: unknown) => ({ status: 'error', error }) as LightningRpcOutcome<unknown>);
      this.note('shadow_record', 'fn_lightning_shadow_record', out);
    }
    if (signals && cfg.integrityEnabled && this.available('integrity_report')) {
      const out = await lightningIntegrityReport(this.deps.rpc, {
        clusterId: this.clusterId,
        signals,
        now: this.now(),
      }).catch((error: unknown) => ({ status: 'error', error }) as LightningRpcOutcome<unknown>);
      this.note('integrity_report', 'fn_lightning_integrity_report', out);
    }
  }

  private available(fn: FnKey): boolean {
    return this.unavailableUntil[fn] <= this.now().getTime();
  }

  private note(fn: FnKey, name: string, out: LightningRpcOutcome<unknown>): void {
    if (out.status === 'ok') {
      const v = out.value as Record<string, unknown> | null;
      if (v && typeof v === 'object' && v.ok === false) {
        if (this.failureLog.shouldLog(`refused:${fn}`)) {
          this.logger.warn(
            `[LightningShadow:${this.clusterId}] ${name} refused the window (${String(v.reason ?? 'unknown')})`
          );
        }
        return;
      }
      this.records++;
      return;
    }
    if (out.status === 'unavailable') {
      this.unavailableUntil[fn] = this.now().getTime() + LIGHTNING_SHADOW_RPC_RETRY_MS;
      if (this.failureLog.shouldLog(`unavailable:${fn}`)) {
        this.logger.warn(
          `[LightningShadow:${this.clusterId}] ${name} is not deployed yet; windows dropped for 10 minutes`
        );
      }
      return;
    }
    if (this.failureLog.shouldLog(`${out.status}:${fn}`)) {
      this.logger.error(
        `[LightningShadow:${this.clusterId}] ${name} failed (${out.status}); window dropped`,
        out.status === 'error' ? out.error : out.reason
      );
    }
  }

  private resetWindow(): void {
    this.live = new SideWindow();
    this.shadow = new SideWindow();
    this.latencies = new Map();
    this.integrity.reset();
    this.skipSize = 0;
    this.skipOverrun = 0;
    this.skipUnknownVersion = 0;
    this.skipLiveFailed = 0;
    this.shadowMsTotal = 0;
    this.shadowRuns = 0;
    this.droppedWindows = 0;
  }

  private resetAll(): void {
    this.resetWindow();
    this.integrity = new LightningIntegrityWindow();
    this.model = new Map();
    this.recentHands = [];
    this.windowStartMs = null;
    this.skipNext = 0;
  }
}
