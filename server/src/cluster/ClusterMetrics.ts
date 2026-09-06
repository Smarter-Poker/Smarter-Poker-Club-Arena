/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUSTER METRICS - the controller's pass, as numbers an alert can read.
 *  2026-09-05.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY. On 2026-09-04 22:10 UTC the ClusterController's pass latch stayed held
 * for eleven minutes - one wake parked a worker, the pass never ended, and
 * every tick after it returned the stale summary with no error and no log
 * line. It was found by a human reading cash_cluster_events by hand. The
 * controller already summarises every pass (ClusterTickSummary) and logs
 * every action the SQL took; nothing turned either into a series Prometheus
 * could scrape, so nothing could page.
 *
 * This module is that turn. It writes into the ALWAYS-ON registry
 * (observability/engineInstruments.ts), which GameServer.getPrometheusMetrics
 * renders on every scrape without the ENGINE_METRICS flag - the gated
 * registry is off in production and a metric nobody scrapes pages nobody.
 *
 * CARDINALITY. Every series here is fleet-wide. The one label, `kind` on
 * poker_cluster_actions_total, is derived from the action objects the SQL
 * returns (`{moves_planned: 2}`, `{feeder: 'opened', buyers: 3}`,
 * `{closed: '<uuid>'}`, `{state: 'live'}`) and is BOUNDED: an id-shaped value
 * folds into the bare key, only a short lowercase word is appended
 * (feeder_opened, main1_reopened, state_dormant), and past MAX_KINDS distinct
 * kinds everything else is `other`. Never a table_id, never a game_id.
 *
 * SHAPE TOLERANCE. A sibling branch adds `rested` and `rpcs` to the summary.
 * Both are read with optional chaining so either shape works; absent means 0.
 *
 * The controller calls three things and nothing else: recordPass() at the end
 * of a pass, recordStalled() where it reports `tick_stalled`, and
 * recordSkippedFrozen() where the break stops it before any I/O. Keeping the
 * controller's edits to those three lines is deliberate - another branch is
 * editing that file heavily.
 */

import type { ClusterRow, ClusterTickSummary } from './ClusterController.js';
import {
  MetricsRegistry,
  type Counter,
  type Gauge,
  type Histogram,
} from '../observability/Metrics.js';
import { alwaysOnRegistry } from '../observability/engineInstruments.js';

/** Pass duration buckets, SECONDS. A pass is ~10 s over 78 games (measured). */
export const CLUSTER_PASS_DURATION_BUCKETS_S = [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60, 120];

/** Distinct action kinds before the label folds into `other`. */
export const MAX_KINDS = 64;

/** Keys that qualify an action rather than name it. */
const AUXILIARY_KEYS = new Set(['buyers', 'count', 'n', 'table_id', 'game_id', 'user_id']);

/** A value worth appending to the kind: a short lowercase word, never an id. */
const WORD = /^[a-z][a-z0-9_]{0,31}$/;

/** What /health publishes under `cluster`. */
export interface ClusterHealthSnapshot {
  lastPassAt: string | null;
  elapsedMs: number;
  games: number;
  ticked: number;
  woken: number;
  errors: number;
  rested: number;
  deferred: number;
  rpcs: number;
  stalled: number;
  skippedFrozen: number;
}

/** The summary as the sibling branch extends it. Both shapes are accepted. */
type SummaryLike = ClusterTickSummary & Partial<{ rested: number; rpcs: number; deferred: number }>;

/**
 * Derive the metric `kind` of one action object. Exported so the test and the
 * rule file can agree on the vocabulary.
 *
 *   {moves_planned: 2}                  -> moves_planned
 *   {feeder: 'opened', buyers: 3}       -> feeder_opened
 *   {main1: 'reopened'}                 -> main1_reopened
 *   {closed: '5f0c...-...'}             -> closed
 *   {second_chair_cashed_out: '<uuid>'} -> second_chair_cashed_out
 *   {state: 'live'}                     -> state_live
 */
export function actionKind(action: unknown): string | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const entries = Object.entries(action as Record<string, unknown>);
  const primary = entries.find(([k]) => !AUXILIARY_KEYS.has(k)) ?? entries[0];
  if (!primary) return null;
  const [key, value] = primary;
  if (!WORD.test(key)) return null;
  if (typeof value === 'string' && WORD.test(value)) return `${key}_${value}`;
  return key;
}

export class ClusterMetrics {
  readonly passDuration: Histogram;
  readonly passGames: Gauge;
  readonly passTicked: Gauge;
  readonly passWoken: Gauge;
  readonly passRested: Gauge;
  readonly passDeferred: Gauge;
  readonly passErrorsTotal: Counter;
  readonly passStalledTotal: Counter;
  readonly passSkippedFrozenTotal: Counter;
  readonly passesTotal: Counter;
  readonly rpcsTotal: Counter;
  readonly lastPassTimestamp: Gauge;
  readonly actionsTotal: Counter;
  readonly games: Gauge;

  private kinds = new Set<string>();
  private lastPassAtMs: number | null = null;
  private last: SummaryLike | null = null;
  private stalled = 0;
  private skippedFrozen = 0;

  constructor(
    registry: MetricsRegistry = alwaysOnRegistry,
    private readonly now: () => number = () => Date.now()
  ) {
    this.passDuration = registry.histogram(
      'poker_cluster_pass_duration_seconds',
      'Wall time of one ClusterController pass over every must-move game (seconds)',
      CLUSTER_PASS_DURATION_BUCKETS_S
    );
    this.passGames = registry.gauge(
      'poker_cluster_pass_games',
      'Must-move games on the worklist of the last pass'
    );
    this.passTicked = registry.gauge(
      'poker_cluster_pass_ticked',
      'Games whose fn_cash_cluster_tick succeeded in the last pass'
    );
    this.passWoken = registry.gauge(
      'poker_cluster_pass_woken',
      'Main 1 tables handed a dealer in the last pass'
    );
    this.passRested = registry.gauge(
      'poker_cluster_pass_rested',
      'Dormant games the last pass let sleep instead of ticking'
    );
    this.passDeferred = registry.gauge(
      'poker_cluster_pass_deferred',
      'Due games the last pass did not start because it reached its 5.5 s budget (20260906150956); first in line next pass'
    );
    this.passErrorsTotal = registry.counter(
      'poker_cluster_pass_errors_total',
      'Per-game tick failures plus worklist failures, cumulative'
    );
    this.passStalledTotal = registry.counter(
      'poker_cluster_pass_stalled_total',
      'Passes found still open past CLUSTER_TICK_STALL_MS and released (the 11-minute latch)'
    );
    this.passSkippedFrozenTotal = registry.counter(
      'poker_cluster_pass_skipped_frozen_total',
      'Ticks skipped because the maintenance freeze was on'
    );
    this.passesTotal = registry.counter(
      'poker_cluster_passes_total',
      'Passes completed (with or without errors)'
    );
    this.rpcsTotal = registry.counter(
      'poker_cluster_rpcs_total',
      'Supabase RPCs the controller issued, cumulative'
    );
    this.lastPassTimestamp = registry.gauge(
      'poker_cluster_last_pass_timestamp_seconds',
      'Unix time the last pass completed; time() - this is how long the controller has been silent'
    );
    this.actionsTotal = registry.counter(
      'poker_cluster_actions_total',
      'Actions fn_cash_cluster_tick reported, by kind (moves_planned, feeder_opened, break_started, closed, state_live, ...)'
    );
    this.games = registry.gauge(
      'poker_cluster_games',
      'Must-move games on the worklist by state (live|dormant)'
    );
  }

  /** The end of a pass, successful or not. `rows` is the worklist when known. */
  recordPass(summary: ClusterTickSummary, rows?: ClusterRow[]): void {
    const s = summary as SummaryLike;
    const at = this.now();
    this.lastPassAtMs = at;
    this.last = s;
    this.passesTotal.inc();
    this.passDuration.observe(Math.max(0, s.elapsedMs) / 1000);
    this.passGames.set(s.games);
    this.passTicked.set(s.ticked);
    this.passWoken.set(s.woken);
    this.passRested.set(s.rested ?? 0);
    this.passDeferred.set(s.deferred ?? 0);
    if (s.errors > 0) this.passErrorsTotal.inc(s.errors);
    if ((s.rpcs ?? 0) > 0) this.rpcsTotal.inc(s.rpcs ?? 0);
    this.lastPassTimestamp.set(Math.floor(at / 1000));
    for (const g of s.actions ?? []) {
      for (const a of g.actions ?? []) this.countAction(a);
    }
    if (rows) {
      const byState: Record<string, number> = { live: 0, dormant: 0 };
      for (const r of rows) {
        const st = typeof r.state === 'string' && WORD.test(r.state) ? r.state : 'other';
        byState[st] = (byState[st] ?? 0) + 1;
      }
      for (const [state, n] of Object.entries(byState)) this.games.set(n, { state });
    }
  }

  /** Where the controller reports `tick_stalled` and releases the latch. */
  recordStalled(): void {
    this.stalled++;
    this.passStalledTotal.inc();
  }

  /** Where the freeze stops a tick before any I/O. */
  recordSkippedFrozen(): void {
    this.skippedFrozen++;
    this.passSkippedFrozenTotal.inc();
  }

  private countAction(action: unknown): void {
    let kind = actionKind(action);
    if (!kind) return;
    if (!this.kinds.has(kind)) {
      if (this.kinds.size >= MAX_KINDS) kind = 'other';
      this.kinds.add(kind);
    }
    this.actionsTotal.inc(1, { kind });
  }

  /** What /health carries under `cluster` while a controller is running. */
  healthSnapshot(): ClusterHealthSnapshot {
    const s = this.last;
    return {
      lastPassAt: this.lastPassAtMs === null ? null : new Date(this.lastPassAtMs).toISOString(),
      elapsedMs: s?.elapsedMs ?? 0,
      games: s?.games ?? 0,
      ticked: s?.ticked ?? 0,
      woken: s?.woken ?? 0,
      errors: s?.errors ?? 0,
      rested: s?.rested ?? 0,
      deferred: s?.deferred ?? 0,
      rpcs: s?.rpcs ?? 0,
      stalled: this.stalled,
      skippedFrozen: this.skippedFrozen,
    };
  }
}

/** The process-wide instance the controller and /health share. */
export const clusterMetrics = new ClusterMetrics();
