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
 * Every other mode is MUST MOVE, exactly as the card has always said. The
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

/** Modes in which the Cluster deals Lightning hands. pending_off still does until it drains. */
export function isLightningMode(mode: string | null | undefined): boolean {
  return mode === 'lightning' || mode === 'pending_off';
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
  if (state.clusterMode === 'pending_off') return 'THIN';
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
  mode: 'lightning' | 'must_move';
  label: 'LIGHTNING LIVE' | 'MUST MOVE';
  players: number;
  status: LightningPoolStatus | null;
}

/** What a Cluster's card says about its mode. */
export function lightningLobbyBadge(input: {
  clusterMode: string | null | undefined;
  state: LightningLobbyState | null | undefined;
  boardPlayers: number;
}): LightningLobbyBadge {
  if (!isLightningMode(input.clusterMode)) {
    return { mode: 'must_move', label: 'MUST MOVE', players: input.boardPlayers, status: null };
  }
  const state = input.state ?? null;
  return {
    mode: 'lightning',
    label: 'LIGHTNING LIVE',
    players: state?.liveEligible ?? input.boardPlayers,
    status: lightningPoolStatus(state),
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
