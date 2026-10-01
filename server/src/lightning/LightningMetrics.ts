/**
 * LIGHTNING SHADOW METRICS (2026-09-25). What the shadow worker learned, as
 * series an alert or a dashboard can read, in the ALWAYS-ON registry that
 * GameServer renders on every scrape (the same one ClusterMetrics uses).
 *
 * CARDINALITY. Every series is fleet-wide: the per-Cluster numbers are kept
 * in memory and SUMMED into the gauges, so a Cluster id is never a label.
 * The two labels are closed sets: `outcome` (the worker's pass outcomes) and
 * `state` (the six diagnosis states from the SQL contract).
 */
import {
  MetricsRegistry,
  type Counter,
  type Gauge,
  type Histogram,
} from '../observability/Metrics.js';
import { alwaysOnRegistry } from '../observability/engineInstruments.js';
import { LIGHTNING_PLAYER_STATES, type LightningDiagnosisSummary } from './LightningRpc.js';

export type LightningPassOutcome =
  | 'matched'
  | 'off'
  | 'frozen'
  | 'refused_form'
  | 'formed'
  | 'skipped'
  | 'unavailable'
  | 'invalid'
  | 'error';

/**
 * ACTION LATENCY TELEMETRY (spec): each leg measured on its own, so a slow
 * next hand can be traced to the leg that is slow. P50/P95/P99 come from the
 * histogram buckets. "Hand creation -> first client render" is measured by the
 * client, which is the only party that sees the render.
 */
export const LIGHTNING_LATENCY_SEGMENTS = [
  'fold_ack',
  'ack_to_idle_pool',
  'idle_pool_to_match',
  'match_to_hand',
  'fast_fold_to_next_hand',
  'normal_fold_to_next_hand',
  'fold_watch_to_next_hand',
] as const;
export type LightningLatencySegment = (typeof LIGHTNING_LATENCY_SEGMENTS)[number];

/** How a player last became free to be matched. */
export type LightningIdleKind = 'fast' | 'normal' | 'fold_watch' | 'hand_end';

/** Players waiting to be matched are remembered at most this long (memory bound). */
const IDLE_MEMORY_MS = 15 * 60_000;
const IDLE_MEMORY_MAX = 50_000;

export class LightningMetrics {
  readonly latencyMs: Histogram;
  readonly handsTotal: Counter;
  readonly foldsTotal: Counter;
  readonly formedTotal: Counter;
  private readonly idle = new Map<string, { at: number; kind: LightningIdleKind }>();
  readonly passesTotal: Counter;
  readonly workers: Gauge;
  readonly diagnosisPlayers: Gauge;
  readonly groups: Gauge;
  readonly legalCount: Gauge;

  private readonly lastByCluster = new Map<string, LightningDiagnosisSummary>();

  constructor(registry: MetricsRegistry = alwaysOnRegistry) {
    this.passesTotal = registry.counter(
      'poker_lightning_worker_passes_total',
      'Lightning worker passes by outcome (matched, off, frozen, refused_form, unavailable, invalid, error)'
    );
    this.workers = registry.gauge(
      'poker_lightning_workers',
      'Lightning Cluster workers running on this process (leader only)'
    );
    this.diagnosisPlayers = registry.gauge(
      'poker_lightning_shadow_players',
      'Pool players in the last shadow diagnosis of every Lightning Cluster, by matcher state'
    );
    this.groups = registry.gauge(
      'poker_lightning_shadow_groups',
      'Groups the matcher would have formed on its last shadow pass, summed over Clusters'
    );
    this.latencyMs = registry.histogram(
      'poker_lightning_latency_ms',
      'Lightning fold-to-next-hand latency by leg (fold_ack, ack_to_idle_pool, idle_pool_to_match, match_to_hand, *_to_next_hand)'
    );
    this.handsTotal = registry.counter(
      'poker_lightning_hands_total',
      'Lightning hands by end (settled, abandoned, settlement_unknown, frozen)'
    );
    this.foldsTotal = registry.counter(
      'poker_lightning_folds_total',
      'Lightning folds recorded by fold type (fast, normal, fold_watch)'
    );
    this.formedTotal = registry.counter(
      'poker_lightning_formed_hands_total',
      'Hands formed by the Lightning matcher on this process'
    );
    this.legalCount = registry.gauge(
      'poker_lightning_shadow_legal_count',
      'legal_count of the last shadow pass, summed over Clusters'
    );
  }

  observeLatency(segment: LightningLatencySegment, ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.latencyMs.observe(ms, { segment });
  }

  recordHand(outcome: 'settled' | 'abandoned' | 'settlement_unknown' | 'frozen'): void {
    this.handsTotal.inc(1, { outcome });
  }

  recordFold(type: 'fast' | 'normal' | 'fold_watch'): void {
    this.foldsTotal.inc(1, { type });
  }

  /** The player is back in the idle pool now. */
  noteIdle(playerId: string, atMs: number, kind: LightningIdleKind): void {
    this.idle.delete(playerId);
    this.idle.set(playerId, { at: atMs, kind });
    if (this.idle.size > IDLE_MEMORY_MAX) {
      for (const [id, v] of this.idle) {
        if (this.idle.size <= IDLE_MEMORY_MAX && atMs - v.at < IDLE_MEMORY_MS) break;
        this.idle.delete(id);
      }
    }
  }

  /** The matcher formed a hand holding these players. */
  noteMatched(playerIds: readonly string[], atMs: number): void {
    this.formedTotal.inc(1);
    for (const id of playerIds) {
      const v = this.idle.get(id);
      if (v && atMs - v.at < IDLE_MEMORY_MS) this.observeLatency('idle_pool_to_match', atMs - v.at);
    }
  }

  /** The players' next hand was dealt: close each fold-to-next-hand leg. */
  noteDealt(playerIds: readonly string[], atMs: number): void {
    for (const id of playerIds) {
      const v = this.idle.get(id);
      this.idle.delete(id);
      if (!v || atMs - v.at >= IDLE_MEMORY_MS || v.kind === 'hand_end') continue;
      const segment: LightningLatencySegment =
        v.kind === 'fold_watch'
          ? 'fold_watch_to_next_hand'
          : v.kind === 'fast'
            ? 'fast_fold_to_next_hand'
            : 'normal_fold_to_next_hand';
      this.observeLatency(segment, atMs - v.at);
    }
  }

  recordPass(outcome: LightningPassOutcome): void {
    this.passesTotal.inc(1, { outcome });
  }

  recordSummary(clusterId: string, summary: LightningDiagnosisSummary): void {
    this.lastByCluster.set(clusterId, summary);
    this.publish();
  }

  /** A worker stopped: its last numbers stop counting. */
  forgetCluster(clusterId: string): void {
    if (this.lastByCluster.delete(clusterId)) this.publish();
  }

  setWorkers(n: number): void {
    this.workers.set(n);
  }

  private publish(): void {
    const byState = Object.fromEntries(LIGHTNING_PLAYER_STATES.map((s) => [s, 0])) as Record<
      string,
      number
    >;
    let groups = 0;
    let legal = 0;
    for (const s of this.lastByCluster.values()) {
      for (const state of LIGHTNING_PLAYER_STATES) byState[state] += s.byState[state] ?? 0;
      groups += s.groups;
      legal += s.legalCount;
    }
    for (const state of LIGHTNING_PLAYER_STATES)
      this.diagnosisPlayers.set(byState[state], { state });
    this.groups.set(groups);
    this.legalCount.set(legal);
  }
}

/** The process-wide instance the supervisor and its workers share. */
export const lightningMetrics = new LightningMetrics();
