/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AUTO-REBUY, ASKED FOR BETWEEN HANDS (Lightning Phase 10, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The database owns every chip of an auto-rebuy: `fn_lightning_auto_rebuy
 * (p_cluster_id, p_player_id, p_now)` - service_role - validates the config,
 * the caps, the responsible-gaming state and the session, moves the money
 * from the anchor seat's own doors, and refuses anything it should. This
 * file only ASKS, and only at the one legal moment: a hand has fully
 * settled and its players have not yet been handed back to the matcher
 * (LightningHandHost calls `onHandSettled` after `fn_lightning_settle_hand`
 * answered ok and before `finish()` releases anyone).
 *
 * THE RULES, IN ONE PLACE:
 *
 *   - config disabled, or the trigger unreadable -> no call at all. The
 *     trigger is computed here only to avoid asking the database about every
 *     stack every hand; the database re-checks everything.
 *   - AT MOST ONE ATTEMPT PER PLAYER PER HAND BOUNDARY. A refusal is
 *     terminal for that boundary, an error is terminal for that boundary:
 *     the next settled hand is the next chance. No retries, ever - a retry
 *     storm against a money door is how a quiet night ends.
 *   - NOT YET DEPLOYED IS NOT A FAULT. "Function not found" (deploy window)
 *     marks the RPC unavailable for ten minutes (the presence reporter's
 *     pattern) and nothing is asked until then.
 *   - NEVER DURING A LIVE HAND. The host calls this at settlement only, and
 *     only for the players this boundary releases: a player who LIGHTNING
 *     folded earlier may already be in another live hand, and their boundary
 *     is that hand's settlement, not this one's.
 *   - LOG-LIGHT. One rate-limited line per condition, never one per hand.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). Every seat this boundary releases is
 * asked by the same rule; there is no is_horse anywhere here.
 */
import { supabase } from '../services/supabase/client.js';
import { isMissingFunctionError } from './rpcErrors.js';
import { isUuid, type LightningRpcClient } from './LightningRpc.js';
import { RateLimitedLog } from './RateLimitedLog.js';
import {
  LIGHTNING_FAILURE_LOG_INTERVAL_MS,
  type LightningAutoRebuyConfig,
} from './LightningConfig.js';
import type { LightningWorkerLogger } from './LightningClusterWorker.js';

/** After "function not found" (deploy window), nothing is asked for this long. */
export const LIGHTNING_AUTO_REBUY_RETRY_MS = 10 * 60_000;

/** Hand boundaries remembered so a replayed settle cannot ask twice. */
const ATTEMPTED_MAX = 4096;

/**
 * The stack at or under which a player is asked about, in chips, or null when
 * the config does not add up to a number (fail closed: no call).
 *
 *   - trigger 'bb':  threshold_bb big blinds;
 *   - trigger 'pct': threshold_pct percent of the target stack, where the
 *     target is auto_rebuy_target big blinds (the stack a rebuy refills to).
 */
export function lightningAutoRebuyTriggerStack(
  config: LightningAutoRebuyConfig,
  bigBlind: number
): number | null {
  if (!config.enabled || !Number.isFinite(bigBlind) || bigBlind <= 0) return null;
  if (config.trigger === 'bb') {
    if (config.thresholdBb === null || config.thresholdBb <= 0) return null;
    return config.thresholdBb * bigBlind;
  }
  if (config.trigger === 'pct') {
    if (config.thresholdPct === null || config.thresholdPct <= 0) return null;
    if (config.targetBb === null || config.targetBb <= 0) return null;
    return (config.thresholdPct / 100) * config.targetBb * bigBlind;
  }
  return null;
}

/** One settled hand's boundary, as the host reports it. */
export interface LightningSettledBoundary {
  clusterId: string;
  handId: string;
  bigBlind: number;
  config: LightningAutoRebuyConfig;
  /** The players this boundary releases, with the stack settlement left them. */
  players: Array<{ playerId: string; stackAfter: number }>;
}

/** The host's view of this executor: one report per settled hand. */
export interface LightningAutoRebuyReport {
  onHandSettled(boundary: LightningSettledBoundary): Promise<void>;
}

export interface LightningAutoRebuyDeps {
  rpc?: LightningRpcClient;
  logger?: LightningWorkerLogger;
  now?: () => number;
}

const defaultRpc: LightningRpcClient = (fn, args) =>
  supabase.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>;

const defaultLogger: LightningWorkerLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ''),
};

export class LightningAutoRebuyExecutor implements LightningAutoRebuyReport {
  /** Epoch ms before which the RPC is treated as not deployed; 0 = usable. */
  private unavailableUntilMs = 0;
  /** `${handId}/${playerId}` boundaries already attempted (bounded). */
  private readonly attempted = new Set<string>();
  private readonly failureLog = new RateLimitedLog(LIGHTNING_FAILURE_LOG_INTERVAL_MS, 16);
  private readonly rpc: LightningRpcClient;
  private readonly logger: LightningWorkerLogger;
  private readonly now: () => number;

  constructor(deps: LightningAutoRebuyDeps = {}) {
    this.rpc = deps.rpc ?? defaultRpc;
    this.logger = deps.logger ?? defaultLogger;
    this.now = deps.now ?? Date.now;
  }

  /**
   * One settled hand: ask the database about every released player whose
   * stack is at or under the trigger, once each. Never throws; the host's
   * settlement path must not depend on a rebuy answering.
   */
  async onHandSettled(boundary: LightningSettledBoundary): Promise<void> {
    if (!boundary.config.enabled) return;
    if (!isUuid(boundary.clusterId) || !boundary.handId) return;
    if (this.unavailableUntilMs > this.now()) return;
    const trigger = lightningAutoRebuyTriggerStack(boundary.config, boundary.bigBlind);
    if (trigger === null) return;
    const due = boundary.players.filter(
      (p) =>
        isUuid(p.playerId) &&
        Number.isFinite(p.stackAfter) &&
        p.stackAfter <= trigger &&
        this.noteAttempt(boundary.handId, p.playerId)
    );
    if (due.length === 0) return;
    await Promise.all(due.map((p) => this.ask(boundary.clusterId, p.playerId)));
  }

  /** True when this (hand, player) boundary has not been attempted; records it. */
  private noteAttempt(handId: string, playerId: string): boolean {
    const key = `${handId}/${playerId}`;
    if (this.attempted.has(key)) return false;
    this.attempted.add(key);
    while (this.attempted.size > ATTEMPTED_MAX) {
      const oldest = this.attempted.values().next().value;
      if (oldest === undefined) break;
      this.attempted.delete(oldest);
    }
    return true;
  }

  /** The one attempt. A refusal or an error is terminal for this boundary. */
  private async ask(clusterId: string, playerId: string): Promise<void> {
    try {
      const { data, error } = await this.rpc('fn_lightning_auto_rebuy', {
        p_cluster_id: clusterId,
        p_player_id: playerId,
        p_now: new Date(this.now()).toISOString(),
      });
      if (error) {
        if (isMissingFunctionError(error)) return this.noteUnavailable();
        throw error;
      }
      const row = data as { ok?: unknown; reason?: unknown } | null;
      if (row && row.ok === false && this.failureLog.shouldLog(`refused:${String(row.reason)}`)) {
        // The database said no (cap reached, RG stop, not eligible): that is
        // the system working, said once per reason per interval.
        this.logger.log(
          `[LightningAutoRebuy:${clusterId}] rebuy refused (${String(row.reason ?? 'refused')})`
        );
      }
    } catch (err) {
      if (isMissingFunctionError(err)) return this.noteUnavailable();
      if (this.failureLog.shouldLog('ask_failed')) {
        this.logger.error(
          `[LightningAutoRebuy:${clusterId}] fn_lightning_auto_rebuy failed; not retried (the next settled hand is the next chance)`,
          err
        );
      }
    }
  }

  private noteUnavailable(): void {
    this.unavailableUntilMs = this.now() + LIGHTNING_AUTO_REBUY_RETRY_MS;
    if (this.failureLog.shouldLog('unavailable')) {
      this.logger.warn(
        '[LightningAutoRebuy] fn_lightning_auto_rebuy is not deployed yet; ' +
          'auto-rebuy is quietly unavailable until it is'
      );
    }
  }
}
