/**
 * LIGHTNING PHASE 6: THE LOBBY CARD OF A LIGHTNING CLUSTER.
 *
 * A Cluster is one row on the board (R10) whether it runs as MUST MOVE or as
 * LIGHTNING. When its mode is Lightning the card says LIGHTNING LIVE, how many
 * players are in the pool, and one word for how the pool is doing:
 *
 *   BUILDING  the pool is below the size that turned Lightning on
 *   ACTIVE    the pool is healthy
 *   HOT       the pool is at least twice the size that turned Lightning on
 *   THIN      the pool is at or below the size that turns Lightning off
 *
 * MUST MOVE is said only for a Cluster whose mode is must_move (or a row that
 * does not carry its mode, which reads as the column's default, must_move).
 * JOIN LIGHTNING is offered only while the mode is lightning: on the way in
 * (pending_on) the card still says MUST MOVE, and on the way out (pending_off,
 * draining) it still says LIGHTNING LIVE, each with the ordinary JOIN GAME
 * door. A paused, frozen or dead Cluster says neither: it is a closed game,
 * in the words the board already uses for one (Game Paused, Game Closed). The
 * numbers come from the one reader of a Cluster's Lightning state,
 * fn_cash_cluster_lightning_state, which fn_cash_game_lobby embeds as
 * `lightning`. It is asked only for a Cluster whose mode is already Lightning,
 * so a board with no Lightning Cluster (every board today) asks nothing more.
 *
 * Pure: the read itself lives in lightningLobbyFeed.ts, so the board's own
 * module graph gains no database client from this file.
 */

export type LightningPoolStatus = 'BUILDING' | 'ACTIVE' | 'HOT' | 'THIN';

export interface LightningLobbyState {
  clusterMode: string | null;
  liveEligible: number | null;
  onThreshold: number | null;
  offThreshold: number | null;
}

/**
 * Modes in which the Cluster still deals Lightning hands: lightning, and on
 * the way out pending_off and draining until the pool has drained.
 */
export function isLightningMode(mode: string | null | undefined): boolean {
  return mode === 'lightning' || mode === 'pending_off' || mode === 'draining';
}

/** What the board says about a Cluster's mode, and which door it offers. */
export interface ClusterModeDisplay {
  /** The mode word on the card, or null for a paused or closed game. */
  label: 'LIGHTNING LIVE' | 'MUST MOVE' | null;
  /** JOIN LIGHTNING is the door. Only while the mode is lightning. */
  joinLightning: boolean;
  /** A game nobody can join right now, in the board's existing words. */
  closedLabel: 'Paused' | 'Closed' | null;
}

export function clusterModeDisplay(mode: string | null | undefined): ClusterModeDisplay {
  if (mode === 'paused' || mode === 'frozen') {
    return { label: null, joinLightning: false, closedLabel: 'Paused' };
  }
  if (mode === 'dead') return { label: null, joinLightning: false, closedLabel: 'Closed' };
  if (isLightningMode(mode)) {
    return { label: 'LIGHTNING LIVE', joinLightning: mode === 'lightning', closedLabel: null };
  }
  return { label: 'MUST MOVE', joinLightning: false, closedLabel: null };
}

function count(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** fn_cash_cluster_lightning_state's jsonb, read defensively. */
export function parseLightningLobbyState(raw: unknown): LightningLobbyState | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  const verdict = (r.verdict ?? null) as Record<string, unknown> | null;
  const thresholds = (r.thresholds ?? null) as Record<string, unknown> | null;
  return {
    clusterMode: typeof r.cluster_mode === 'string' ? r.cluster_mode : null,
    liveEligible: count(verdict?.live_eligible),
    onThreshold: count(thresholds?.on),
    offThreshold: count(thresholds?.off),
  };
}

export function lightningPoolStatus(state: LightningLobbyState | null): LightningPoolStatus {
  if (!state) return 'BUILDING';
  if (state.clusterMode === 'pending_off' || state.clusterMode === 'draining') return 'THIN';
  const live = state.liveEligible;
  if (live === null) return 'BUILDING';
  if (state.offThreshold !== null && live <= state.offThreshold) return 'THIN';
  if (state.onThreshold !== null && live < state.onThreshold) return 'BUILDING';
  if (state.onThreshold !== null && state.onThreshold > 0 && live >= 2 * state.onThreshold) {
    return 'HOT';
  }
  return 'ACTIVE';
}

export interface LightningLobbyBadge {
  mode: 'lightning' | 'must_move' | 'closed';
  label: 'LIGHTNING LIVE' | 'MUST MOVE' | null;
  players: number;
  status: LightningPoolStatus | null;
  /** JOIN LIGHTNING is offered. True only while the mode is lightning. */
  joinLightning: boolean;
  /** Set for a paused, frozen or dead Cluster: no join is offered at all. */
  closedLabel: 'Paused' | 'Closed' | null;
}

/** What a Cluster's card says about its mode. */
export function lightningLobbyBadge(input: {
  clusterMode: string | null | undefined;
  state: LightningLobbyState | null | undefined;
  boardPlayers: number;
}): LightningLobbyBadge {
  const display = clusterModeDisplay(input.clusterMode);
  if (display.closedLabel) {
    return {
      mode: 'closed',
      label: null,
      players: input.boardPlayers,
      status: null,
      joinLightning: false,
      closedLabel: display.closedLabel,
    };
  }
  if (display.label !== 'LIGHTNING LIVE') {
    return {
      mode: 'must_move',
      label: 'MUST MOVE',
      players: input.boardPlayers,
      status: null,
      joinLightning: false,
      closedLabel: null,
    };
  }
  const state = input.state ?? null;
  return {
    mode: 'lightning',
    label: 'LIGHTNING LIVE',
    players: state?.liveEligible ?? input.boardPlayers,
    /* On its way out the pool is THIN by definition, whatever the last read said. */
    status: input.clusterMode === 'lightning' ? lightningPoolStatus(state) : 'THIN',
    joinLightning: display.joinLightning,
    closedLabel: null,
  };
}

/** The Lightning route for a Cluster. The only door a Lightning card opens. */
export function lightningRoute(clusterId: string): string {
  return `/lightning/${clusterId}`;
}

interface LightningBoardRow {
  cluster_id?: string | null;
  cluster_mode?: string | null;
  cluster_lightning?: LightningLobbyState | null;
}

/** The Clusters on a board whose mode is Lightning, each once. Empty on every board today. */
export function lightningClusterIdsOf(rows: ReadonlyArray<LightningBoardRow>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.cluster_id && isLightningMode(r.cluster_mode)) out.add(String(r.cluster_id));
  }
  return [...out].sort();
}

/**
 * Stamp each Lightning Cluster's rows with its pool state. A row that is not
 * Lightning, or whose state is unchanged, is returned as the same object, so
 * a board with no Lightning Cluster is returned exactly as it came in.
 */
export function withLightningState<T extends LightningBoardRow>(
  rows: ReadonlyArray<T>,
  states: Readonly<Record<string, LightningLobbyState | null>>
): T[] {
  return rows.map((r) => {
    if (!r.cluster_id || !isLightningMode(r.cluster_mode)) return r;
    const state = states[String(r.cluster_id)] ?? null;
    if (JSON.stringify(r.cluster_lightning ?? null) === JSON.stringify(state)) return r;
    return { ...r, cluster_lightning: state };
  });
}
