/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BOOT RECONCILIATION: THE RESTARTED ENGINE'S FIRST PRESENCE TRUTH
 *  (Lightning Phase 9 remediation, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An engine restart loses the registry's in-memory socket counts. A player
 * who disconnected BEFORE the restart and never returns is a player the new
 * process has never heard of: no socket of theirs will ever drop here, so no
 * disconnect transition is ever reported, and their pool session sits open -
 * invisible to the reaper, whose clock starts at `disconnected_at` - until
 * the anchor-seat stand-up backstop finally claims it.
 *
 * So, once after boot (a short delay after the engine starts accepting
 * sockets, so returning players have reconnected first), this pass reads the
 * OPEN pool sessions and reports as disconnected every one whose player
 * holds no socket here right now. It feeds the ordinary reporter path, so
 * the batching, the deploy-window tolerance and the drop-on-failure contract
 * for disconnect entries all apply unchanged. The presence door is
 * idempotent: telling the database about a player it already stamped costs
 * nothing, and a player who reconnects a moment later is un-stamped by that
 * socket's own transition.
 *
 * ONE PASS, LOG-LIGHT, TOLERANT. A read that fails (the table or the
 * function not deployed yet included) reconciles nothing, says so once at
 * warn, and the engine carries on: this is a convergence aid, never a boot
 * dependency.
 */
import { supabase } from '../services/supabase/client.js';
import { isUuid } from './LightningRpc.js';
import type { LightningPresenceReport } from './LightningPresenceReporter.js';
import type { LightningWorkerLogger } from './LightningClusterWorker.js';

/** How long after boot the one pass runs: returning sockets land first. */
export const LIGHTNING_PRESENCE_RECONCILE_DELAY_MS = 30_000;

/** One open pool session, as the pass needs it. */
export interface LightningOpenSession {
  clusterId: string;
  playerId: string;
}

export interface LightningPresenceReconciliationDeps {
  /** The open pool sessions (exited_at is null). Defaults to the one select. */
  openSessions?: () => Promise<LightningOpenSession[]>;
  /** Does this player hold a live socket in this Cluster here, right now? */
  isConnected: (clusterId: string, playerId: string) => boolean;
  /** The ordinary reporter: batching and tolerance come with it. */
  report: LightningPresenceReport;
  logger?: Pick<LightningWorkerLogger, 'warn'>;
}

/** The one select: every open pool session's player and Cluster. */
export async function readOpenLightningSessions(): Promise<LightningOpenSession[]> {
  const { data, error } = await supabase
    .from('lightning_pool_session')
    .select('player_id, cluster_id')
    .is('exited_at', null);
  if (error) throw new Error(`lightning_pool_session read failed: ${error.message}`);
  const out: LightningOpenSession[] = [];
  for (const r of (data ?? []) as Array<{ player_id?: unknown; cluster_id?: unknown }>) {
    if (isUuid(r.player_id) && isUuid(r.cluster_id)) {
      out.push({ clusterId: r.cluster_id, playerId: r.player_id });
    }
  }
  return out;
}

/**
 * The one pass. Returns how many players were reported disconnected; a read
 * that fails returns 0 and warns once. Never throws.
 */
export async function reconcileLightningPresence(
  deps: LightningPresenceReconciliationDeps
): Promise<number> {
  const read = deps.openSessions ?? readOpenLightningSessions;
  let sessions: LightningOpenSession[];
  try {
    sessions = await read();
  } catch (err) {
    deps.logger?.warn(
      '[LightningPresenceReconciliation] open-session read failed; nothing reconciled ' +
        `(${err instanceof Error ? err.message : String(err)})`
    );
    return 0;
  }
  let reported = 0;
  for (const { clusterId, playerId } of sessions) {
    let connected = false;
    try {
      connected = deps.isConnected(clusterId, playerId);
    } catch {
      /* a presence probe must never take the pass down; absent is reported */
    }
    if (connected) continue;
    try {
      deps.report.disconnected(clusterId, playerId);
      reported++;
    } catch {
      /* the reporter owns its own failures */
    }
  }
  return reported;
}
