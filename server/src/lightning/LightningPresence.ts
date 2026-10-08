/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PRESENCE FEED: WHO IN A LIGHTNING POOL IS NOT HERE (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_lightning_match` takes `p_disconnected uuid[]`: the pool players the
 * matcher must NOT deal in because their client is not there. The database
 * cannot know that - sockets live in this process - so the worker derives it
 * from the one authority that already decides presence for every table: the
 * engine's in-memory DisconnectEngine, read through the ANCHOR tables (the
 * Cluster's own tables, where every pool player keeps a seat while the Cluster
 * is Lightning).
 *
 * THE RULE, AND WHY IT FAILS CLOSED. The list is a deny list: a player NOT on
 * it is taken to be present. So an answer of "I don't know" must never be
 * spelled by leaving a player off it. Every pool player lands in exactly one
 * bucket:
 *
 *   connected        - an anchor engine here has a presence entry for them
 *                      that says CONNECTED (or a sit-out whose socket is up);
 *   disconnected     - an anchor engine says MISSING or DISCONNECTED;
 *   unknown          - nobody here can vouch for them: no engine in this
 *                      process holds their anchor table, the engine has no
 *                      presence entry for them yet, or they are a pool member
 *                      the last diagnosis named who is not seated at any
 *                      anchor table this process runs.
 *
 * `disconnected` and `unknown` BOTH go into p_disconnected. An unknown player
 * therefore waits (WAITING_FOR_RECONNECT) rather than being dealt into a hand
 * they may not be at. Being wrong in that direction costs a player one pass;
 * being wrong in the other deals a hand to an empty chair.
 *
 * WHERE A PLAYER IS SEEN TWICE (two anchor seats, or a move in flight) a
 * CONNECTED observation wins: a live socket anywhere is proof the client is
 * there, and a stale entry at the old table is not proof it is not.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). A horse's presence comes from the same
 * DisconnectEngine entry as a human's (the engine heartbeats it), and it is
 * reported by exactly the same rule. There is no is_horse anywhere here.
 *
 * WHAT THIS CANNOT SEE. A pool player the process has never observed and the
 * matcher has not yet named. The first pass of a new worker can only know
 * the players seated at in-process anchor tables; from the second pass on,
 * every player the previous diagnosis named is covered (as `unknown` when
 * nothing here observes them). This matters only once a worker FORMS hands;
 * the shadow worker writes nothing, and 'form' is refused (see
 * LightningClusterWorker) until a dealing host exists.
 */

/** One observation of one seat's client. */
export type SeatPresence = 'connected' | 'disconnected' | 'unknown';

/**
 * LIGHTNING PHASE 8: the device class a player's client reported. It feeds
 * `p_player_platforms`, which the matcher reads to hold a player to their
 * platform's Cluster limit (fn_lightning_config.multi_table_limit).
 */
export type LightningDevicePlatform = 'desktop' | 'tablet' | 'mobile';

/** Narrowest first: where two reports disagree, the narrower limit wins. */
const PLATFORM_RANK: Record<LightningDevicePlatform, number> = {
  mobile: 0,
  tablet: 1,
  desktop: 2,
};

/** What an anchor table's engine reports about the players seated at it. */
export interface PresenceTableReport {
  tableId: string;
  clusterId: string | null;
  players: Array<{
    userId: string;
    presence: SeatPresence;
    /** Reported only by a Lightning room whose socket said `?p=`. */
    platform?: LightningDevicePlatform | null;
  }>;
}

/** Whatever can list this process's engines' reports. Injected; GameServer supplies it. */
export type PresenceSource = () => Iterable<PresenceTableReport>;

export interface LightningPresenceSnapshot {
  connected: string[];
  disconnected: string[];
  unknown: string[];
  /** disconnected + unknown, sorted and unique: the p_disconnected feed. */
  pDisconnected: string[];
  /** Anchor tables of this Cluster that an engine here reported on. */
  anchorTables: number;
  /**
   * Player id -> reported device class, for EVERY connected player some
   * report named a platform for - this Cluster's and others' alike. Reports
   * from every Cluster are read (the limit is per player, across Clusters,
   * and the narrowest report wins), and nothing is filtered to the players
   * seen here: a worker's first pass has no knownPoolPlayers yet, and
   * narrowing to them would throw away cross-Cluster platform knowledge the
   * matcher needs. A player with no report is left out, and the SQL applies
   * its default (the narrowest, mobile). An entry the matcher does not need
   * is simply unread.
   */
  platforms: Record<string, LightningDevicePlatform>;
}

export class LightningPresence {
  constructor(private readonly source: PresenceSource) {}

  /**
   * The Cluster's presence right now. `knownPoolPlayers` is who the last
   * diagnosis named: anyone in it that no anchor engine here observes is
   * reported unknown, and so withheld from the deal.
   */
  snapshot(clusterId: string, knownPoolPlayers: Iterable<string> = []): LightningPresenceSnapshot {
    const seen = new Map<string, SeatPresence>();
    const platforms = new Map<string, LightningDevicePlatform>();
    let anchorTables = 0;
    for (const report of this.source()) {
      if (!report) continue;
      for (const { userId, platform } of report.players) {
        if (!userId || !platform || !(platform in PLATFORM_RANK)) continue;
        const prior = platforms.get(userId);
        if (!prior || PLATFORM_RANK[platform] < PLATFORM_RANK[prior])
          platforms.set(userId, platform);
      }
      if (report.clusterId !== clusterId) continue;
      anchorTables++;
      for (const { userId, presence } of report.players) {
        if (!userId) continue;
        const prior = seen.get(userId);
        seen.set(userId, merge(prior, presence));
      }
    }
    for (const userId of knownPoolPlayers) {
      if (userId && !seen.has(userId)) seen.set(userId, 'unknown');
    }
    const connected: string[] = [];
    const disconnected: string[] = [];
    const unknown: string[] = [];
    for (const [userId, presence] of seen) {
      if (presence === 'connected') connected.push(userId);
      else if (presence === 'disconnected') disconnected.push(userId);
      else unknown.push(userId);
    }
    connected.sort();
    disconnected.sort();
    unknown.sort();
    return {
      connected,
      disconnected,
      unknown,
      pDisconnected: [...new Set([...disconnected, ...unknown])].sort(),
      anchorTables,
      platforms: Object.fromEntries(
        [...platforms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      ),
    };
  }
}

/** Connected anywhere wins; then a definite disconnect; unknown only if nothing better. */
function merge(prior: SeatPresence | undefined, next: SeatPresence): SeatPresence {
  if (prior === 'connected' || next === 'connected') return 'connected';
  if (prior === 'disconnected' || next === 'disconnected') return 'disconnected';
  return 'unknown';
}

/** The DisconnectEngine's FSM label, mapped onto presence. */
export function presenceFromFsm(
  fsmState: 'CONNECTED' | 'MISSING' | 'DISCONNECTED' | 'SAT_OUT' | null | undefined,
  socketConnected: boolean
): SeatPresence {
  switch (fsmState) {
    case 'CONNECTED':
      return 'connected';
    case 'MISSING':
    case 'DISCONNECTED':
      return 'disconnected';
    case 'SAT_OUT':
      // A sit-out says nothing about the socket; the socket flag does.
      return socketConnected ? 'connected' : 'disconnected';
    default:
      // No entry: this engine has never observed the player. Not "present".
      return 'unknown';
  }
}
