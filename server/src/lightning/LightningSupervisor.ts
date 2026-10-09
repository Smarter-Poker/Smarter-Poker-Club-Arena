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
 * A Cluster HOLDS A WORKER when both hold:
 *   - `cash_games.cluster_mode` is `lightning` or `pending_off`,
 *   - its `fn_lightning_config` says `worker_mode <> 'off'`.
 * It FORMS only when it is in `lightning` with `lightning_enabled = true`;
 * otherwise its worker is DRAINING (see below).
 *
 * ONE CHEAP QUERY PER INTERVAL. The first is a single select of
 * `id, cluster_mode, lightning_enabled` over `cash_games`, every
 * LIGHTNING_DISCOVERY_INTERVAL_MS. Only a Cluster that passes it costs a
 * second call (`fn_lightning_config`), and today none does: every Cluster is
 * must_move with Lightning disabled, so this ships dark and costs one tiny
 * select every fifteen seconds on the leader.
 *
 * FAIL CLOSED. A discovery read that fails changes nothing (the workers that
 * are running keep running, none is started); a config that cannot be read
 * or is not deployed is `off`, so its Cluster gets no worker - and a Cluster
 * whose config turns `off` loses the one it had.
 *
 * ON THE WAY OUT (Lightning Phase 7, 2026-10-02). LIGHTNING -> MUST_MOVE
 * passes through `pending_off`: the database refuses to form a new hand and
 * still settles the ones in the air. Discovery therefore finds `pending_off`
 * Clusters as well (whatever `lightning_enabled` says), and their worker is
 * DRAINING: it calls no matcher and
 * forms nothing, while every hand already dealt plays on to settlement under
 * its own host (keepalives included) - a Cluster that merely stopped
 * qualifying would instead have its hands abandoned. When the commit sets
 * `must_move` the Cluster leaves discovery, its worker stops, and the
 * ended-room sweep is run at once so every room it held closes with
 * "Lightning Has Ended" instead of up to a sweep interval later.
 *
 * SWITCHED OFF (Lightning Phase 7 review, 2026-10-07). An operator turning
 * `lightning_enabled` off on a Cluster still in `lightning` starts that same
 * drain: the database's tick moves it to `pending_off` and promises the hands
 * in the air finish. Until the tick does, the Cluster is discovered as
 * DRAINING too - no new hand forms, every host keeps running - instead of
 * dropping out of discovery, which would stop its worker and void the hands
 * being dealt. A worker stops (and its unsettled hands are abandoned) only
 * when its Cluster is MUST MOVE or gone, frozen, its config `off`, or the
 * leader steps down.
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
import {
  LightningClusterWorker,
  type LightningClusterWorkerDeps,
  type LightningWorkerLogger,
} from './LightningClusterWorker.js';
import { lightningMetrics, type LightningMetrics } from './LightningMetrics.js';
import { RateLimitedLog } from './RateLimitedLog.js';
import type { LightningHosting } from './LightningRegistry.js';
import { lightningFrontTable } from '../services/supabase/lightningAnchor.js';

export interface LightningSupervisorDeps {
  /** This process's anchor-table presence (GameServer's engines). */
  presenceSource: PresenceSource;
  /**
   * Clusters passing the cash_games filter. Defaults to the one select. A
   * bare id is a Cluster in `lightning`; `{ draining: true }` is one in
   * `pending_off` (or in `lightning` with Lightning switched off), on its way
   * back to MUST MOVE.
   */
  discover?: () => Promise<Array<string | LightningDiscoveredCluster>>;
  rpc?: LightningRpcClient;
  metrics?: LightningMetrics;
  logger?: LightningWorkerLogger;
  frozen?: () => boolean;
  now?: () => Date;
  /**
   * The dealing host (Lightning Phase 6). Without it a 'form' worker refuses
   * to form. Every unsettled hand of a Cluster whose worker stops - leadership
   * lost, shutdown, the Cluster no longer qualifying - is abandoned through it.
   */
  hosting?: LightningHosting;
  /** Injected for tests; the real worker otherwise. */
  createWorker?: (clusterId: string, config: LightningConfig) => LightningClusterWorker;
  /**
   * Close the sockets of every Lightning room whose pool session has ended
   * (LightningRegistry.sweepEndedRooms), run every ROOM_SWEEP_INTERVAL_MS.
   */
  sweepRooms?: () => Promise<unknown>;
  /** The Cluster's front table (the host table every hand binds to). */
  frontTable?: (clusterId: string) => Promise<string | null>;
  /**
   * LIGHTNING PHASE 12: options handed to every worker this supervisor makes
   * (the formation gate and the forming call's timeout; tests shorten it).
   */
  workerOptions?: Partial<Pick<LightningClusterWorkerDeps, 'formationGate' | 'formTimeoutMs'>>;
}

/** One Cluster discovery found, and whether it is on its way out of Lightning. */
export interface LightningDiscoveredCluster {
  clusterId: string;
  /**
   * `pending_off`, or `lightning` with `lightning_enabled` off: no new hand
   * forms; the hands in the air settle.
   */
  draining: boolean;
}

/** The Cluster modes that hold a worker: running, and draining on the way out. */
export const LIGHTNING_WORKER_CLUSTER_MODES = ['lightning', 'pending_off'] as const;

/** How often ended Lightning rooms are looked for (their sockets closed). */
export const LIGHTNING_ROOM_SWEEP_INTERVAL_MS = 5_000;
/** How long a Cluster's front table id is trusted before it is read again. */
const FRONT_TABLE_TTL_MS = 30_000;

/**
 * The one discovery read: Clusters in Lightning mode, or draining out of it
 * (`pending_off`), whatever `lightning_enabled` says - a Cluster switched off
 * mid-hand drains rather than disappears.
 */
export async function discoverLightningClusters(): Promise<LightningDiscoveredCluster[]> {
  const { data, error } = await supabase
    .from('cash_games')
    .select('id, cluster_mode, lightning_enabled')
    .in('cluster_mode', [...LIGHTNING_WORKER_CLUSTER_MODES]);
  if (error) throw error;
  return parseDiscoveredClusters(data);
}

/**
 * The discovery rows, read defensively: an unknown mode is no Cluster at all,
 * and a `lightning` Cluster forms only with `lightning_enabled` exactly true
 * (switched off, or unreadable, it drains).
 */
export function parseDiscoveredClusters(rows: unknown): LightningDiscoveredCluster[] {
  const out: LightningDiscoveredCluster[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { id?: unknown; cluster_mode?: unknown; lightning_enabled?: unknown } | null;
    if (!r || !isUuid(r.id)) continue;
    if (r.cluster_mode !== 'lightning' && r.cluster_mode !== 'pending_off') continue;
    out.push({
      clusterId: r.id,
      draining: r.cluster_mode === 'pending_off' || r.lightning_enabled !== true,
    });
  }
  return out;
}

function normalizeDiscovered(
  found: Array<string | LightningDiscoveredCluster>
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const item of found) {
    if (typeof item === 'string') {
      if (isUuid(item)) out.set(item, out.get(item) ?? false);
    } else if (item && isUuid(item.clusterId)) {
      out.set(item.clusterId, item.draining === true || out.get(item.clusterId) === true);
    }
  }
  return out;
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
  private readonly discover: () => Promise<Array<string | LightningDiscoveredCluster>>;
  private readonly metrics: LightningMetrics;
  private readonly logger: LightningWorkerLogger;
  private readonly frozen: () => boolean;
  private roomSweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly frontTables = new Map<string, { tableId: string | null; at: number }>();

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

  /**
   * LIGHTNING PHASE 12: a player arrived in this Cluster's pool (their room's
   * first socket). Its worker runs its next pass within the admission window.
   * A Cluster with no worker here (a standby, or not Lightning) ignores it.
   */
  admit(clusterId: string): void {
    if (!this.running) return;
    try {
      this.workers.get(clusterId)?.admit();
    } catch {
      /* an admission hint must never take the supervisor down */
    }
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
    if (this.deps.sweepRooms && !this.roomSweepTimer) {
      const sweep = this.deps.sweepRooms;
      this.roomSweepTimer = setInterval(() => {
        if (!this.running || generation !== this.generation) return;
        void Promise.resolve()
          .then(sweep)
          .catch((err) => {
            if (this.failureLog.shouldLog('room_sweep'))
              this.logger.error('[LightningSupervisor] ended-room sweep failed', err);
          });
      }, LIGHTNING_ROOM_SWEEP_INTERVAL_MS);
      (this.roomSweepTimer as { unref?: () => void }).unref?.();
    }
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
    if (this.roomSweepTimer) {
      clearInterval(this.roomSweepTimer);
      this.roomSweepTimer = null;
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
    let candidates: Map<string, boolean>;
    try {
      candidates = normalizeDiscovered(await this.discover());
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
    for (const clusterId of candidates.keys()) {
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
    let stoppedAny = false;
    for (const [clusterId, worker] of [...this.workers]) {
      if (qualifying.has(clusterId)) continue;
      this.workers.delete(clusterId);
      stoppedAny = true;
      this.logger.log(
        `[LightningSupervisor] ${clusterId} no longer qualifies - stopping its worker`
      );
      await worker.stop();
      // After LIGHTNING -> MUST_MOVE nothing is left to abandon: the commit
      // waited for every hand to settle. Lightning switched off never lands
      // here (it drains above); anything else that ends a worker (the Cluster
      // gone, config off) voids what has not settled.
      await this.deps.hosting?.abortCluster(clusterId, 'worker_stopped');
    }
    if (!this.running || generation !== this.generation) return;
    // A Cluster that left Lightning: close its rooms now, not a sweep later.
    if (stoppedAny && this.deps.sweepRooms) {
      const sweep = this.deps.sweepRooms;
      void Promise.resolve()
        .then(sweep)
        .catch((err) => {
          if (this.failureLog.shouldLog('room_sweep'))
            this.logger.error('[LightningSupervisor] ended-room sweep failed', err);
        });
    }

    // Start the new ones; hand the others their fresh config and mode.
    for (const [clusterId, config] of qualifying) {
      const draining = candidates.get(clusterId) === true;
      const existing = this.workers.get(clusterId);
      if (existing) {
        if (!sameLightningConfig(existing.currentConfig, config)) existing.updateConfig(config);
        existing.setDraining(draining);
        continue;
      }
      const worker = this.createWorker(clusterId, config);
      this.workers.set(clusterId, worker);
      worker.setDraining(draining);
      worker.start();
    }
    this.metrics.setWorkers(this.workers.size);
  }

  private createWorker(clusterId: string, config: LightningConfig): LightningClusterWorker {
    if (this.deps.createWorker) return this.deps.createWorker(clusterId, config);
    const hosting = this.deps.hosting;
    // A frozen Cluster (barrier or settlement): its worker stops for good,
    // and every hand of it that has not reached settlement is abandoned (a
    // hand already settling is left alone: settlement answers for itself).
    const onFrozen = (id: string): void => {
      if (this.workers.get(id) === worker) this.workers.delete(id);
      this.metrics.setWorkers(this.workers.size);
      void worker.stop().catch(() => undefined);
      void hosting?.abortCluster(id, 'cluster_frozen').catch(() => undefined);
    };
    const worker: LightningClusterWorker = new LightningClusterWorker(clusterId, config, {
      ...(this.deps.workerOptions ?? {}),
      rpc: this.rpc,
      presence: this.presence,
      metrics: this.metrics,
      logger: this.logger,
      frozen: this.frozen,
      now: this.deps.now,
      ...(hosting
        ? {
            startHand: (hand) => {
              hosting.startHand(
                hand,
                worker.currentConfig,
                () => worker.wake(),
                (id) => onFrozen(id)
              );
            },
            hasInstance: (id) => hosting.hasInstance(id),
            onClusterFrozen: (id) => onFrozen(id),
            formBackoffUntil: () => hosting.formBackoffUntil(clusterId),
            holdsFrontTableLease: async () => {
              const front = await this.frontTableOf(clusterId);
              return front !== null && hosting.leaseFor(front) !== null;
            },
          }
        : {}),
    });
    return worker;
  }

  /** The Cluster's front table, cached briefly (the host table every hand binds to). */
  private async frontTableOf(clusterId: string): Promise<string | null> {
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const cached = this.frontTables.get(clusterId);
    if (cached && nowMs - cached.at < FRONT_TABLE_TTL_MS) return cached.tableId;
    const tableId = await (this.deps.frontTable ?? lightningFrontTable)(clusterId);
    this.frontTables.set(clusterId, { tableId, at: nowMs });
    return tableId;
  }

  private async stopAllWorkers(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(workers.map((w) => w.stop()));
    // Leadership is gone: no hand this process formed may be settled under it.
    await this.deps.hosting?.abortAll('leadership_lost');
    this.metrics.setWorkers(0);
  }
}
