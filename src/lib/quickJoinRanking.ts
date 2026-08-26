/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  QUICK JOIN RANKING — what the "+" sheet offers, in what order
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23: "'quick join' should be users favorite games, or similar
 * games to the one they are playing."
 *
 * WHAT IT DID BEFORE. `MultiTablePage.handleAddTable` fetched up to 30 of the
 * club's open cash tables and sorted them with four lines: exact string match
 * on the stakes label first ("0.05/0.10" === "0.05/0.10"), then fullest first.
 * That has three real failures:
 *
 *   1. FAVOURITES WERE NOT CONSULTED AT ALL. `favorite_tables` exists (migration
 *      20260821010000) and FavoriteTablesWidget reads it, but the one surface
 *      whose entire job is "get me into a game fast" ignored it.
 *   2. "SIMILAR" MEANT IDENTICAL STAKES AND NOTHING ELSE. A PLO player at 1/2
 *      got a 1/2 Hold'em table above a 2/5 PLO table — the wrong game at the
 *      right price, ranked over the right game at a near price. Variant was
 *      never compared.
 *   3. THE MATCH WAS A STRING COMPARE. "0.5/1" and "0.50/1.00" are the same
 *      game and never matched, because the label is built by interpolation from
 *      whatever precision the row happens to carry.
 *
 * THE ORDER. Favourites, then near-identical games, then the same game at any
 * stake, then everything else. Inside every tier: a table with a seat beats one
 * without, a busier table beats a quieter one (a two-hander is not a game), and
 * closer stakes beat further ones. Fully deterministic — no Math.random, no
 * dependence on the order the database returned rows in — so the same club
 * state always produces the same sheet and the tests can pin it.
 *
 * Pure on purpose: no Supabase, no React, no clock. The caller fetches, this
 * decides.
 */

import { gameCode } from '../utils/gameCode';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** One joinable table, shaped like the `tables` columns Quick Join selects. */
export interface QuickJoinCandidate {
  id: string;
  name: string;
  /** `tables.game_variant` — lowercase enum ('nlh', 'plo5', 'short_deck'). */
  variant?: string | null;
  smallBlind?: number | null;
  bigBlind?: number | null;
  /** `tables.current_players`. */
  players?: number | null;
  /** `tables.max_players`. */
  maxPlayers?: number | null;
}

/** The table the player is sitting at right now, when there is one. */
export interface QuickJoinCurrentTable {
  id?: string | null;
  variant?: string | null;
  bigBlind?: number | null;
}

export type QuickJoinTier = 'favorite' | 'similar' | 'same-game' | 'other';

export interface RankedQuickJoinTable extends QuickJoinCandidate {
  tier: QuickJoinTier;
  /**
   * Title Case, no em dashes (house rule for player-facing copy). Rendered on
   * the row so the order is self-explaining rather than mysterious.
   */
  reason: string;
  /** Seats free right now. Exposed so the row can render it without recomputing. */
  seatsOpen: number;
}

export interface RankQuickJoinOptions {
  /** `favorite_tables.table_id` for this user. Order within it is ignored. */
  favoriteTableIds?: ReadonlyArray<string> | null;
  /** The active tab's table, used for the "similar" tier. */
  currentTable?: QuickJoinCurrentTable | null;
  /** Tables already open in another tab, plus anything else to hide. */
  excludeIds?: ReadonlyArray<string> | null;
  /** How many rows the sheet shows. The sheet fits five. */
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMILARITY RULES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How far the big blind may drift and still count as "comparable stakes".
 *
 * 2.5x either way, measured as a RATIO rather than a difference, because stakes
 * are geometric: the ladder a club actually runs is 0.05/0.10, 0.10/0.25,
 * 0.25/0.50, 0.50/1, 1/2, 2/5, 5/10. From 1/2 that admits 0.50/1 below and 2/5
 * above — the neighbours a player would genuinely take a seat at — and excludes
 * 5/10, which is a different bankroll decision. A fixed plus-or-minus window
 * cannot do this: 2 either way would be everything at the bottom of the ladder
 * and nothing at the top.
 */
export const STAKES_SIMILARITY_RATIO = 2.5;

/**
 * The comparable-game token for a table. Delegates to `gameCode` so this file
 * does not grow a second, drifting copy of the variant alias table (nlh/nlhe/
 * holdem/texas_holdem all mean one game; plo/plo4/omaha likewise).
 *
 * `maxPlayers` is deliberately NOT passed: `gameCode` would return 'HU' for a
 * 2-seat table, which would make a heads-up PLO game look like a different
 * VARIANT from a 6-max PLO game. Seat count is a separate axis and is not part
 * of "same game".
 */
export function variantKey(variant?: string | null): string {
  return gameCode({ variant }) || 'UNKNOWN';
}

/** Both tables run the same poker game, whatever the stakes. */
export function isSameVariant(a?: string | null, b?: string | null): boolean {
  const ka = variantKey(a);
  const kb = variantKey(b);
  // An unknown variant matches nothing, including another unknown: two rows the
  // mapper could not identify are not evidence they are the same game.
  if (ka === 'UNKNOWN' || kb === 'UNKNOWN') return false;
  return ka === kb;
}

/** Stakes are within STAKES_SIMILARITY_RATIO of each other. */
export function isNearStakes(bigBlindA?: number | null, bigBlindB?: number | null): boolean {
  const a = Number(bigBlindA);
  const b = Number(bigBlindB);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  const ratio = a > b ? a / b : b / a;
  return ratio <= STAKES_SIMILARITY_RATIO;
}

/**
 * Recover the big blind from a "sb/bb" label such as "0.05/0.10" or "1/2".
 *
 * The multi-table tab stores stakes as that STRING and nothing numeric, so when
 * the current table's own database row is not in the candidate set (it can fall
 * outside the 30-row fetch, or be a tournament) this is the only handle on the
 * stake level. Returns null rather than 0 for anything unparseable, so callers
 * cannot mistake "unknown" for "free".
 */
export function bigBlindFromStakesLabel(label?: string | null): number | null {
  if (!label) return null;
  const parts = String(label).split('/');
  if (parts.length < 2) return null;
  const bb = Number(parts[1].trim());
  return Number.isFinite(bb) && bb > 0 ? bb : null;
}

/**
 * Distance between two stake levels, for tie-breaking only. Log-ratio so that
 * 1/2 is exactly as far from 0.50/1 as it is from 2/5, which is how a player
 * reads the ladder. Unknown stakes sort last rather than first.
 */
export function stakesDistance(bigBlindA?: number | null, bigBlindB?: number | null): number {
  const a = Number(bigBlindA);
  const b = Number(bigBlindB);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(Math.log(a / b));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIERING
// ═══════════════════════════════════════════════════════════════════════════════

const TIER_ORDER: Record<QuickJoinTier, number> = {
  favorite: 0,
  similar: 1,
  'same-game': 2,
  other: 3,
};

const TIER_REASON: Record<QuickJoinTier, string> = {
  favorite: 'Favourite',
  similar: 'Similar Game',
  'same-game': 'Same Game',
  other: 'Open Seats',
};

export function tierFor(
  candidate: QuickJoinCandidate,
  favorites: ReadonlySet<string>,
  currentTable?: QuickJoinCurrentTable | null
): QuickJoinTier {
  if (favorites.has(candidate.id)) return 'favorite';
  if (!currentTable) return 'other';
  if (!isSameVariant(candidate.variant, currentTable.variant)) return 'other';
  return isNearStakes(candidate.bigBlind, currentTable.bigBlind) ? 'similar' : 'same-game';
}

function seatsOpenOf(candidate: QuickJoinCandidate): number {
  const seated = Number(candidate.players) || 0;
  const capacity = Number(candidate.maxPlayers) || 0;
  return Math.max(0, capacity - seated);
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE RANKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Order the candidates and return the top `limit`.
 *
 * A player with no favourites and no current table still gets a sensible list:
 * every row lands in 'other' and the tie-breakers alone rank it — joinable
 * first, busiest first, then by name so the sheet does not reshuffle between
 * two identical-looking fetches.
 */
export function rankQuickJoinTables(
  candidates: ReadonlyArray<QuickJoinCandidate>,
  options: RankQuickJoinOptions = {}
): RankedQuickJoinTable[] {
  const { favoriteTableIds, currentTable, excludeIds, limit = 5 } = options;

  const favorites = new Set((favoriteTableIds || []).filter(Boolean));
  const excluded = new Set((excludeIds || []).filter(Boolean));
  // The table you are sitting at is never an offer to join a new table, even
  // when the caller forgot to exclude it.
  if (currentTable?.id) excluded.add(currentTable.id);

  const ranked = (candidates || [])
    .filter((c) => c && c.id && !excluded.has(c.id))
    .map<RankedQuickJoinTable>((c) => {
      const tier = tierFor(c, favorites, currentTable);
      return { ...c, tier, reason: TIER_REASON[tier], seatsOpen: seatsOpenOf(c) };
    });

  ranked.sort((a, b) => {
    // 1. Tier: favourites, then similar, then same game, then the rest.
    const tierDelta = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDelta !== 0) return tierDelta;

    // 2. A table you can actually sit at outranks a full one. Quick Join is a
    //    seat, not a browse; a full favourite is still worth listing (it is the
    //    game you want) but never above one with a chair free.
    const joinableDelta = (b.seatsOpen > 0 ? 1 : 0) - (a.seatsOpen > 0 ? 1 : 0);
    if (joinableDelta !== 0) return joinableDelta;

    // 3. Busier first. A table with one player is a wait, not a game — this is
    //    the one rule carried over verbatim from the old inline sort.
    const playersDelta = (Number(b.players) || 0) - (Number(a.players) || 0);
    if (playersDelta !== 0) return playersDelta;

    // 4. Closer stakes to the game being played. Skipped entirely when there is
    //    no current table, where both distances are Infinity and this is a
    //    no-op rather than an arbitrary preference.
    if (currentTable) {
      const distDelta =
        stakesDistance(a.bigBlind, currentTable.bigBlind) -
        stakesDistance(b.bigBlind, currentTable.bigBlind);
      if (Number.isFinite(distDelta) && distDelta !== 0) return distDelta;
    }

    // 5. Deterministic last resort. Without this the sheet can reorder between
    //    two fetches that returned the same rows in a different order, which
    //    reads as the list flickering under the player's thumb.
    return (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);
  });

  return ranked.slice(0, Math.max(0, limit));
}

export default rankQuickJoinTables;
