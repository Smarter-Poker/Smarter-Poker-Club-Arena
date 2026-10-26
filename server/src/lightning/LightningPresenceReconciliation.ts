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
 * OPEN pool sessions and reports as disconnected every player absent from
 * the same anchor-engine and Lightning-room presence authority as matching.
 * A room socket is not the only live input device: the anchor engine also
 * reports ordinary DisconnectEngine presence, including server heartbeats. It feeds the ordinary reporter path, so
 * the batching, the deploy-window tolerance and the drop-on-failure contract
 * for disconnect entries all apply unchanged. The presence door is
 * idempotent: telling the database about a player it already stamped costs
 * nothing, and a player who reconnects a moment later is un-stamped by that
 * socket's own transition.
 *
 * ONLY A DEFINITE ABSENCE IS STAMPED (2026-10-17). The stamp starts the
 * reaper's clock, and the reaper EXITS the pool session, so it is a verdict,
 * not a precaution. A player whose anchor table no engine here reports on yet
 * is UNKNOWN, and unknown is never stamped. Measured on the private Lightning
 * pilot: the pass ran 30 s after the 13:55 boot, inside the maintenance
 * freeze, before any anchor engine was back; every one of the 54 seated
 * players (all horses, whose input device is the anchor engine's heartbeat,
 * never a room socket) read as absent and was stamped at 13:56, nothing could
 * ever un-stamp them (only a room socket reports a reconnect), and the reaper
 * exited all 54 at 15:00:55. The matcher's per-pass feed still withholds an
 * unknown player from the deal, so skipping the stamp deals nobody to an empty
 * chair; it only stops a missing report from expelling them.
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
import { LightningPresence, type PresenceSource } from './LightningPresence.js';

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
  /** The matcher's complete authority: anchor engines and Lightning rooms. */
  presenceSource?: PresenceSource;
  /** Narrow injectable probe for callers without a full presence source. */
  isConnected?: (clusterId: string, playerId: string) => boolean;
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
  const connectedByCluster = new Map<string, Set<string>>();
  const absentByCluster = new Map<string, Set<string>>();
  if (deps.presenceSource) {
    try {
      // Observe once, so the whole boot pass judges one consistent set of
      // engine reports. CONNECTED wins over a stale room disconnect exactly
      // as it does for matching; no player-type inference is needed.
      const reports = [...deps.presenceSource()];
      const presence = new LightningPresence(() => reports);
      for (const { clusterId } of sessions) {
        if (connectedByCluster.has(clusterId)) continue;
        const snap = presence.snapshot(clusterId);
        // The presence door's view, not matching's: connected ANYWHERE here
        // is never stamped away (LightningPresence, 2026-10-26).
        connectedByCluster.set(clusterId, new Set(snap.connectedAnywhere));
        // Seen by this Cluster's own anchor or room AND not connected anywhere.
        absentByCluster.set(clusterId, new Set(snap.disconnectedAnywhere));
      }
    } catch (err) {
      deps.logger?.warn(
        '[LightningPresenceReconciliation] presence read failed; nothing reconciled ' +
          `(${err instanceof Error ? err.message : String(err)})`
      );
      return 0;
    }
  } else if (!deps.isConnected) {
    deps.logger?.warn(
      '[LightningPresenceReconciliation] presence authority unavailable; nothing reconciled'
    );
    return 0;
  }
  for (const { clusterId, playerId } of sessions) {
    let connected = false;
    try {
      connected = deps.presenceSource
        ? connectedByCluster.get(clusterId)?.has(playerId) === true
        : deps.isConnected!(clusterId, playerId);
    } catch {
      /* a presence probe must never take the pass down; absent is reported */
    }
    if (connected) continue;
    // Unknown is not absent: nobody here reported on this player's anchor.
    if (deps.presenceSource && absentByCluster.get(clusterId)?.has(playerId) !== true) continue;
    try {
      deps.report.disconnected(clusterId, playerId);
      reported++;
    } catch {
      /* the reporter owns its own failures */
    }
  }
  return reported;
}
