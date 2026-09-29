/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LIGHTNING SUPERVISOR - LEADER ONLY, DARK BY DEFAULT (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decides which Clusters get a LightningClusterWorker on this process and
 * keeps that set true. Started beside the ClusterController, behind the same
 * leader gate in GameServer.start() (a standby returns before either), and
 * stopped with it on leadership loss or shutdown.
 *
 * A Cluster QUALIFIES when all three hold:
 *   - `cash_games.cluster_mode = 'lightning'`,
 *   - `cash_games.lightning_enabled = true`,
 *   - its `fn_lightning_config` says `worker_mode <> 'off'`.
 *
 * ONE CHEAP QUERY PER INTERVAL. The first two are a single select of `id`
 * over `cash_games` with two equality filters, every
 * LIGHTNING_DISCOVERY_INTERVAL_MS. Only a Cluster that passes it costs a
 * second call (`fn_lightning_config`), and today none does: every Cluster is
 * must_move with Lightning disabled, so this ships dark and costs one tiny
 * select every fifteen seconds on the leader.
 *
 * FAIL CLOSED. A discovery read that fails changes nothing (the workers that
 * are running keep running, none is started); a config that cannot be read
 * or is not deployed is `off`, so its Cluster gets no worker - and a Cluster
 * whose config turns `off` loses the one it had.
 */
import { supabase } from '../services/supabase.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import {
  LIGHTNING_DISCOVERY_INTERVAL_MS,
  LIGHTNING_FAILURE_LOG_INTERVAL_MS,
  sameLightningConfig,
  type LightningConfig,
} from './LightningConfig.js';
import { isUuid, lightningConfig, type LightningRpcClient } from './LightningRpc.js';
import { LightningPresence, type PresenceSource } from './LightningPresence.js';
import { LightningClusterWorker, type LightningWorkerLogger } from './LightningClusterWorker.js';
import { lightningMetrics, type LightningMetrics } from './LightningMetrics.js';
import { RateLimitedLog } from './RateLimitedLog.js';

export interface LightningSupervisorDeps {
  /** This process's anchor-table presence (GameServer's engines). */
  presenceSource: PresenceSource;
  /** Clusters passing the cash_games filter. Defaults to the one select. */
  discover?: () => Promise<string[]>;
  rpc?: LightningRpcClient;
  metrics?: LightningMetrics;
  logger?: LightningWorkerLogger;
  frozen?: () => boolean;
  now?: () => Date;
  /** Injected for tests; the real worker otherwise. */
  createWorker?: (clusterId: string, config: LightningConfig) => LightningClusterWorker;
}

/** The one discovery read: Clusters in Lightning mode with Lightning enabled. */
export async function discoverLightningClusters(): Promise<string[]> {
  const { data, error } = await supabase
    .from('cash_games')
    .select('id')
    .eq('cluster_mode', 'lightning')
    .eq('lightning_enabled', true);
  if (error) throw error;
  return (data ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => isUuid(id));
}

const defaultRpc: LightningRpcClient = (fn, args) =>
  supabase.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>;

const consoleLogger: LightningWorkerLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ''),
};

export class LightningSupervisor {
  private readonly workers = new Map<string, LightningClusterWorker>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private stopOperation: Promise<void> | null = null;
  private readonly failureLog = new RateLimitedLog(LIGHTNING_FAILURE_LOG_INTERVAL_MS, 16);
  private readonly presence: LightningPresence;
  private readonly rpc: LightningRpcClient;
  private readonly discover: () => Promise<string[]>;
  private readonly metrics: LightningMetrics;
  private readonly logger: LightningWorkerLogger;
  private readonly frozen: () => boolean;

  constructor(private readonly deps: LightningSupervisorDeps) {
    this.presence = new LightningPresence(deps.presenceSource);
    this.rpc = deps.rpc ?? defaultRpc;
    this.discover = deps.discover ?? discoverLightningClusters;
    this.metrics = deps.metrics ?? lightningMetrics;
    this.logger = deps.logger ?? consoleLogger;
    this.frozen = deps.frozen ?? isMaintenanceFrozen;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Cluster ids with a running worker, sorted. */
  activeClusters(): string[] {
    return [...this.workers.keys()].sort();
  }

  workerFor(clusterId: string): LightningClusterWorker | undefined {
    return this.workers.get(clusterId);
  }

  /** Leader only: GameServer calls this beside the ClusterController's start. */
  start(): void {
    if (this.running) return;
    if (this.stopOperation) {
      this.logger.warn(
        '[LightningSupervisor] start refused while the prior generation is stopping'
      );
      return;
    }
    this.running = true;
    const generation = ++this.generation;
    this.logger.log(
      `[LightningSupervisor] running - discovery every ${LIGHTNING_DISCOVERY_INTERVAL_MS / 1000}s on the leader`
    );
    this.arm(generation, 0);
  }

  /**
   * Leadership lost or shutting down: no further discovery, every worker
   * stopped, and a discovery pass already in flight waited for, so nothing
   * this process started survives the call.
   */
  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    this.running = false;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const op = (async () => {
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      await this.stopAllWorkers();
    })();
    const tracked = op.finally(() => {
      if (this.stopOperation === tracked) this.stopOperation = null;
    });
    this.stopOperation = tracked;
    return tracked;
  }

  private arm(generation: number, delayMs: number): void {
    if (!this.running || generation !== this.generation) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || generation !== this.generation) return;
      const pass = this.reconcile(generation);
      this.inFlight = pass;
      void pass.finally(() => {
        if (this.inFlight === pass) this.inFlight = null;
        this.arm(generation, LIGHTNING_DISCOVERY_INTERVAL_MS);
      });
    }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * One discovery pass: find the qualifying Clusters and make the running
   * set equal to them. Public for tests; never throws.
   */
  async reconcile(generation: number = this.generation): Promise<void> {
    // A supervisor that is not running (a standby, or after leadership loss)
    // makes no request at all.
    if (!this.running || generation !== this.generation) return;
    if (this.frozen()) return;
    let candidates: string[];
    try {
      candidates = await this.discover();
    } catch (err) {
      if (this.failureLog.shouldLog('discover')) {
        this.logger.error(
          '[LightningSupervisor] discovery read failed; workers left as they are',
          err
        );
      }
      return;
    }
    if (!this.running || generation !== this.generation) return;

    const qualifying = new Map<string, LightningConfig>();
    for (const clusterId of new Set(candidates)) {
      const out = await lightningConfig(this.rpc, clusterId);
      if (!this.running || generation !== this.generation) return;
      if (out.status !== 'ok') {
        if (out.status !== 'unavailable' && this.failureLog.shouldLog('config:' + clusterId)) {
          this.logger.error(
            `[LightningSupervisor] config for ${clusterId} unreadable (${out.status}); treated as off`,
            out.status === 'error' ? out.error : out.reason
          );
        } else if (
          out.status === 'unavailable' &&
          this.failureLog.shouldLog('config_unavailable')
        ) {
          this.logger.warn(
            '[LightningSupervisor] fn_lightning_config is not deployed yet; every Cluster is off'
          );
        }
        continue;
      }
      if (out.value.workerMode === 'off') continue;
      qualifying.set(clusterId, out.value);
    }

    // Stop the workers whose Cluster no longer qualifies.
    for (const [clusterId, worker] of [...this.workers]) {
      if (qualifying.has(clusterId)) continue;
      this.workers.delete(clusterId);
      this.logger.log(
        `[LightningSupervisor] ${clusterId} no longer qualifies - stopping its worker`
      );
      await worker.stop();
    }
    if (!this.running || generation !== this.generation) return;

    // Start the new ones; hand the others their fresh config.
    for (const [clusterId, config] of qualifying) {
      const existing = this.workers.get(clusterId);
      if (existing) {
        if (!sameLightningConfig(existing.currentConfig, config)) existing.updateConfig(config);
        continue;
      }
      const worker = this.createWorker(clusterId, config);
      this.workers.set(clusterId, worker);
      worker.start();
    }
    this.metrics.setWorkers(this.workers.size);
  }

  private createWorker(clusterId: string, config: LightningConfig): LightningClusterWorker {
    if (this.deps.createWorker) return this.deps.createWorker(clusterId, config);
    return new LightningClusterWorker(clusterId, config, {
      rpc: this.rpc,
      presence: this.presence,
      metrics: this.metrics,
      logger: this.logger,
      frozen: this.frozen,
      now: this.deps.now,
    });
  }

  private async stopAllWorkers(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(workers.map((w) => w.stop()));
    this.metrics.setWorkers(0);
  }
}
