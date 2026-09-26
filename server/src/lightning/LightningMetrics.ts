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
import { MetricsRegistry, type Counter, type Gauge } from '../observability/Metrics.js';
import { alwaysOnRegistry } from '../observability/engineInstruments.js';
import { LIGHTNING_PLAYER_STATES, type LightningDiagnosisSummary } from './LightningRpc.js';

export type LightningPassOutcome =
  | 'matched'
  | 'off'
  | 'frozen'
  | 'refused_form'
  | 'unavailable'
  | 'invalid'
  | 'error';

export class LightningMetrics {
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
    this.legalCount = registry.gauge(
      'poker_lightning_shadow_legal_count',
      'legal_count of the last shadow pass, summed over Clusters'
    );
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
