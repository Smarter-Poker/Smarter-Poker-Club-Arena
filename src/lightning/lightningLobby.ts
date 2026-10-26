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

/** Owner rule: Classic stays ordinary poker. Missing or unknown templates are ineligible. */
export function isLightningTemplate(template: unknown): boolean {
  return template === 'action' || template === 'madness';
}

/** Owner rule, 2026-10-19: "make all lightning games 6 handed". Exactly six seats. */
export const LIGHTNING_TABLE_SIZE = 6;

/** A missing, unreadable or any other table size is ineligible. */
export function isLightningTableSize(handedness: unknown): boolean {
  return handedness === LIGHTNING_TABLE_SIZE;
}

/**
 * Owner rulings, 2026-10-25: "SHORT DESK AND OMAHA HI LOW SHOULD NOT BE RUNNING
 * LIGHTNING AT THIS POINT, JUST FEEDER GAMES." / "AND PINNEAPPLE AS WELL,
 * SHOULD ONLY BE FEEDER GAME, NOT LIGHTNING". These variants run only as
 * ordinary feeder games. Mirrors fn_lightning_variant_allowed in the database.
 */
export const LIGHTNING_EXCLUDED_VARIANTS: readonly string[] = [
  'short_deck',
  'shortdeck',
  'flo8',
  'plo8',
  'omaha8',
  'o8',
  'pineapple',
  'pineapple_holdem',
];

/** A missing or excluded variant is ineligible; case, spaces and dashes are ignored. */
export function isLightningVariant(variant: unknown): boolean {
  if (typeof variant !== 'string' || variant.trim() === '') return false;
  const key = variant
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return !LIGHTNING_EXCLUDED_VARIANTS.includes(key);
}

/**
 * Lightning is offered only for a six-seat Action or Madness game whose
 * variant may run Lightning. Every other game - Classic, unknown, Action or
 * Madness at any other size, or Short Deck, Omaha Hi-Lo and Pineapple - keeps
 * its ordinary entry and lobby actions. The database refuses the rest the same
 * way (cash_games_lightning_six_seat_only, LIGHTNING_TABLE_SIZE_NOT_ALLOWED,
 * cash_games_lightning_variant_allowed, LIGHTNING_VARIANT_NOT_ALLOWED). A
 * read that does not carry the variant (undefined) keeps the template-and-size
 * answer; the database still refuses an excluded variant on its own.
 */
export function isLightningEligible(
  template: unknown,
  handedness: unknown,
  variant?: unknown
): boolean {
  if (!isLightningTemplate(template) || !isLightningTableSize(handedness)) return false;
  return variant === undefined || isLightningVariant(variant);
}

export type LightningPoolStatus = 'BUILDING' | 'ACTIVE' | 'HOT' | 'THIN';

export interface LightningLobbyState {
  clusterMode: string | null;
  liveEligible: number | null;
  onThreshold: number | null;
  offThreshold: number | null;
  /**
   * LIGHTNING PHASE 8: the database's own verdict (fn_lightning_pool_status)
   * and its player count, when it answered. The card prefers them over the
   * status derived from the thresholds above.
   */
  poolStatus?: LightningPoolStatus | null;
  poolPlayers?: number | null;
  /**
   * LIGHTNING PHASE 13: false while an operator has stopped new players
   * entering the pool. Present only when the Cluster's state carries it.
   */
  joinsEnabled?: boolean;
  /**
   * The game's own Lightning switch (cash_games.lightning_enabled). False on
   * every Classic game. Present only when the Cluster's state carries it.
   */
  lightningEnabled?: boolean;
}

/**
 * Modes in which the Cluster still deals Lightning hands: lightning, and on
 * the way out pending_off and draining until the pool has drained.
 */
export function isLightningMode(mode: string | null | undefined): boolean {
  return mode === 'lightning' || mode === 'pending_off' || mode === 'draining';
}

/**
 * A Classic game: its Lightning switch is off and it is not dealing (or
 * draining) Lightning. fn_cash_cluster_lightning_state answers with a full
 * object for EVERY cash game, Classic included (measured 2026-10-24: 246
 * must_move games, lightning_enabled false), so "has a state" never means
 * "is Lightning". No state at all (the game does not exist) is Classic too.
 * Dan 2026-10-24: "NO PART OF THE LIGHTNING GAMES OR FUNCTIONALITY SHOULD BE
 * TOUCHING THE CLASSIC GAMES."
 */
export function isClassicLobbyState(state: LightningLobbyState | null | undefined): boolean {
  if (!state) return true;
  return state.lightningEnabled === false && !isLightningMode(state.clusterMode);
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
  const joins =
    typeof r.joins_enabled === 'boolean'
      ? r.joins_enabled
      : typeof r.lightning_joins_enabled === 'boolean'
        ? r.lightning_joins_enabled
        : undefined;
  return {
    clusterMode: typeof r.cluster_mode === 'string' ? r.cluster_mode : null,
    liveEligible: count(verdict?.live_eligible),
    onThreshold: count(thresholds?.on),
    offThreshold: count(thresholds?.off),
    // LIGHTNING PHASE 13: only when the state says so; absent decides nothing.
    ...(joins !== undefined ? { joinsEnabled: joins } : {}),
    ...(typeof r.lightning_enabled === 'boolean' ? { lightningEnabled: r.lightning_enabled } : {}),
  };
}

export function lightningPoolStatus(state: LightningLobbyState | null): LightningPoolStatus {
  if (!state) return 'BUILDING';
  if (state.poolStatus) return state.poolStatus;
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
  /**
   * LIGHTNING PHASE 13: an operator has stopped new players entering the
   * pool. JOIN LIGHTNING is still shown, and not offered. Present only then.
   */
  joinsClosed?: true;
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
    players: state?.poolPlayers ?? state?.liveEligible ?? input.boardPlayers,
    /* On its way out the pool is THIN by definition, whatever the last read said. */
    status: input.clusterMode === 'lightning' ? lightningPoolStatus(state) : 'THIN',
    joinLightning: display.joinLightning,
    closedLabel: null,
    ...(display.joinLightning && state?.joinsEnabled === false
      ? { joinsClosed: true as const }
      : {}),
  };
}

/** The Lightning route for a Cluster. The only door a Lightning card opens. */
export function lightningRoute(clusterId: string): string {
  return `/lightning/${clusterId}`;
}

/**
 * JOIN LIGHTNING, as one tap (Dan 2026-10-24): the game's door with the
 * amount question already open. A player who already holds a pool session
 * still goes straight to their room; one already seated is shown their seat.
 */
export function lightningJoinRoute(clusterId: string): string {
  return `${lightningRoute(clusterId)}?join=1`;
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
