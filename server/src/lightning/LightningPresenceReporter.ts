/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PRESENCE TRANSITIONS, TOLD TO THE DATABASE (Lightning Phase 9, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The per-pass `p_disconnected` feed already decides who the matcher deals;
 * this file is the OTHER half of the disconnect contract: the database keeps
 * each pool session's `disconnected_at`, and its reaper
 * (`fn_lightning_reap_expired_disconnects`, wired into the DB tick) exits a
 * session whose player has been gone longer than the Cluster's
 * `disconnect_timeout_ms`. The database cannot see a socket, so this reporter
 * tells it - ON TRANSITIONS ONLY, never per pass:
 *
 *   - a Lightning player's LAST socket in their room dropped -> disconnected;
 *   - their FIRST socket returned                            -> reconnected.
 *
 * Transitions within one Cluster are batched inside a short debounce
 * (LIGHTNING_PRESENCE_REPORT_DEBOUNCE_MS), the LAST state per player winning,
 * so a flapping socket costs one RPC, not one per flap. One call:
 * `fn_lightning_presence_report(p_cluster_id, p_disconnected uuid[],
 * p_reconnected uuid[], p_now)` - service_role, which the engine's client is.
 *
 * NOT YET DEPLOYED IS NOT A FAULT. The engine ships ahead of the migration,
 * so a "function not found" answer marks the RPC unavailable, the batch is
 * dropped quietly, and nothing is sent again until the retry time. The
 * matcher's fail-closed presence feed never depended on this call: a report
 * that is lost costs the database only the precision of `disconnected_at`,
 * and the next transition says it again.
 */
import { supabase } from '../services/supabase/client.js';
import { isMissingFunctionError } from './rpcErrors.js';
import { isUuid, type LightningRpcClient } from './LightningRpc.js';
import { RateLimitedLog } from './RateLimitedLog.js';
import { LIGHTNING_FAILURE_LOG_INTERVAL_MS } from './LightningConfig.js';
import type { LightningWorkerLogger } from './LightningClusterWorker.js';

/** Transitions in one Cluster are batched this long before the one RPC. */
export const LIGHTNING_PRESENCE_REPORT_DEBOUNCE_MS = 2_000;

/** After "function not found" (deploy window), nothing is sent for this long. */
export const LIGHTNING_PRESENCE_REPORT_RETRY_MS = 10 * 60_000;

/** The registry's view of this reporter: the two transitions, nothing else. */
export interface LightningPresenceReport {
  disconnected(clusterId: string, playerId: string): void;
  reconnected(clusterId: string, playerId: string): void;
}

export interface LightningPresenceReporterDeps {
  rpc?: LightningRpcClient;
  logger?: LightningWorkerLogger;
  now?: () => number;
  debounceMs?: number;
}

const defaultRpc: LightningRpcClient = (fn, args) =>
  supabase.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>;

const defaultLogger: LightningWorkerLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ''),
};

export class LightningPresenceReporter implements LightningPresenceReport {
  /** Per Cluster: player id -> the LAST transition seen inside the debounce. */
  private readonly pending = new Map<string, Map<string, 'disconnected' | 'reconnected'>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failureLog = new RateLimitedLog(LIGHTNING_FAILURE_LOG_INTERVAL_MS, 8);
  /** Epoch ms before which the RPC is treated as not deployed; 0 = usable. */
  private unavailableUntilMs = 0;
  private stopped = false;
  private readonly rpc: LightningRpcClient;
  private readonly logger: LightningWorkerLogger;
  private readonly now: () => number;
  private readonly debounceMs: number;
  /** In-flight flushes, so a shutdown (or a test) can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: LightningPresenceReporterDeps = {}) {
    this.rpc = deps.rpc ?? defaultRpc;
    this.logger = deps.logger ?? defaultLogger;
    this.now = deps.now ?? Date.now;
    this.debounceMs = deps.debounceMs ?? LIGHTNING_PRESENCE_REPORT_DEBOUNCE_MS;
  }

  disconnected(clusterId: string, playerId: string): void {
    this.note(clusterId, playerId, 'disconnected');
  }

  reconnected(clusterId: string, playerId: string): void {
    this.note(clusterId, playerId, 'reconnected');
  }

  /** Transitions waiting to be sent (diagnostics and tests). */
  pendingCount(): number {
    let n = 0;
    for (const m of this.pending.values()) n += m.size;
    return n;
  }

  private note(clusterId: string, playerId: string, kind: 'disconnected' | 'reconnected'): void {
    if (this.stopped || !isUuid(clusterId) || !isUuid(playerId)) return;
    // The deploy window: the RPC is not there, so a batch would only be dropped.
    if (this.unavailableUntilMs > this.now()) return;
    let batch = this.pending.get(clusterId);
    if (!batch) {
      batch = new Map();
      this.pending.set(clusterId, batch);
    }
    // The LAST state wins: a drop followed by a return inside the debounce is
    // reported as reconnected, which is the state the database should hold.
    batch.set(playerId, kind);
    if (!this.timers.has(clusterId)) {
      const timer = setTimeout(() => {
        this.timers.delete(clusterId);
        const run = this.flush(clusterId);
        this.inFlight.add(run);
        void run.finally(() => this.inFlight.delete(run));
      }, this.debounceMs);
      (timer as { unref?: () => void }).unref?.();
      this.timers.set(clusterId, timer);
    }
  }

  /** Send one Cluster's batch now. Never throws; a failed batch is dropped. */
  async flush(clusterId: string): Promise<void> {
    const timer = this.timers.get(clusterId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(clusterId);
    }
    const batch = this.pending.get(clusterId);
    this.pending.delete(clusterId);
    if (!batch || batch.size === 0) return;
    const disconnected: string[] = [];
    const reconnected: string[] = [];
    for (const [playerId, kind] of batch) {
      (kind === 'disconnected' ? disconnected : reconnected).push(playerId);
    }
    disconnected.sort();
    reconnected.sort();
    try {
      const { error } = await this.rpc('fn_lightning_presence_report', {
        p_cluster_id: clusterId,
        p_disconnected: disconnected,
        p_reconnected: reconnected,
        p_now: new Date(this.now()).toISOString(),
      });
      if (!error) return;
      if (isMissingFunctionError(error)) {
        this.noteUnavailable();
        return;
      }
      throw error;
    } catch (err) {
      if (isMissingFunctionError(err)) {
        this.noteUnavailable();
        return;
      }
      // Dropped, not retried: the next transition reports the same fact, and
      // the matcher's own presence feed never depended on this call.
      if (this.failureLog.shouldLog('report_failed')) {
        this.logger.error(
          `[LightningPresenceReporter:${clusterId}] fn_lightning_presence_report failed; batch dropped`,
          err
        );
      }
    }
  }

  private noteUnavailable(): void {
    this.unavailableUntilMs = this.now() + LIGHTNING_PRESENCE_REPORT_RETRY_MS;
    this.pending.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.failureLog.shouldLog('unavailable')) {
      this.logger.warn(
        '[LightningPresenceReporter] fn_lightning_presence_report is not deployed yet; ' +
          'transitions are not reported until it is (the per-pass presence feed still withholds)'
      );
    }
  }

  /** Flush everything pending and stop. Further transitions are ignored. */
  async stop(): Promise<void> {
    this.stopped = true;
    const clusters = [...new Set([...this.pending.keys(), ...this.timers.keys()])];
    await Promise.allSettled(clusters.map((c) => this.flush(c)));
    await Promise.allSettled([...this.inFlight]);
  }
}
