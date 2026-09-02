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
 * THE ORDER (rewritten 2026-08-26). Favourites, then the SAME GAME AT THE SAME
 * STAKES, then ONE RUNG UP OR DOWN on the ladder the club is actually running,
 * then the same game at any stake, then everything else. Inside every tier: a
 * table with a seat beats one without, a busier table beats a quieter one (a
 * two-hander is not a game), and closer stakes beat further ones. Fully
 * deterministic — no Math.random, no dependence on the order the database
 * returned rows in — so the same club state always produces the same sheet and
 * the tests can pin it.
 *
 * Pure on purpose: no Supabase, no React, no clock. The caller fetches, this
 * decides.
 */

import { gameCode } from '../utils/gameCode';
import { isFixedLimitVariant } from './bettingStructure';

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

/**
 * ONE RUNG EITHER WAY (Dan 2026-08-26).
 *
 * "IT SHOULD SHOW YOU IF THERE ARE ANY OTHER GAMES THAT ARE EXACTLY LIKE THE
 *  GAME YOU ARE CURRENTLY ON, IN THIS CASE 1/2 PLO, AND FIND ANY OTHER 1/2 PLO
 *  GAMES, BUT ALSO SHOW ANY GAMES THAT ARE ONE STAKES LEVEL LOWER, AND ONE
 *  HIGHER."
 *
 * `similar` is gone and two tiers stand where it did: `exact` (the same game at
 * the same stakes) and `adjacent` (one rung up or one rung down). The old tier
 * was a 2.5x ratio band, which is not a rung — it swept up the same game two
 * rungs away on a tight ladder and missed the genuine neighbour on a loose one,
 * and it could never say WHICH direction a table was, so no row could carry the
 * label Dan is asking for here.
 */
export type QuickJoinTier = 'favorite' | 'exact' | 'adjacent' | 'same-game' | 'other';

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
  /** The active tab's table: the game and rung every tier is measured from. */
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
 * STAKES_SIMILARITY_RATIO AND isNearStakes ARE GONE (Dan 2026-08-26).
 *
 * They defined "comparable stakes" as a 2.5x band around the current big
 * blind, on the reasoning that a club's ladder is roughly geometric so a fixed
 * ratio approximates its neighbours. It approximates them; it does not find
 * them. On the ladder this platform actually runs (0.10/0.20, 0.25/0.50,
 * 0.50/1, 1/2, 2/4, 3/6, 5/10, 10/25, 25/50) a 2.5x band around 1/2 catches
 * 2/4 AND 5/10 — two rungs up — while calling neither of them a rung, so the
 * sheet could not tell a player which direction anything was.
 *
 * `stakeLadderFor` + `rungOffset` below answer the question that was actually
 * being asked, against the rungs the club is running right now.
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

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

/**
 * Recover the big blind from a stakes label such as "0.05/0.10" or "1/2".
 *
 * The multi-table tab stores stakes as that STRING and nothing numeric, so when
 * the current table's own database row cannot be found this is the last handle
 * on the stake level. Returns null rather than 0 for anything unparseable, so
 * callers cannot mistake "unknown" for "free".
 *
 * FIXED LIMIT PUTS THE BIG BLIND FIRST. `stakesLabel` renders a limit game as
 * its BET SIZES -- `${bigBlind}/${bigBlind * 2}` -- because that is what a
 * limit player reads. So on a 2/4 limit table the big blind is 2, the FIRST
 * number, while on a 1/2 no-limit table it is 2, the SECOND. Reading index 1
 * unconditionally doubled every limit table's stake and put it a rung or two
 * up its own ladder, which mis-tiers every Quick Join row for that player.
 */
export function bigBlindFromStakesLabel(
  label?: string | null,
  variant?: string | null
): number | null {
  if (!label) return null;
  const parts = String(label).split('/');
  if (parts.length < 2) return null;
  const bb = Number(parts[isFixedLimitVariant(variant) ? 0 : 1].trim());
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
  exact: 1,
  adjacent: 2,
  'same-game': 3,
  other: 4,
};

const TIER_REASON: Record<QuickJoinTier, string> = {
  favorite: 'Favourite',
  exact: 'Same Stakes',
  adjacent: 'One Level Away',
  'same-game': 'Same Game',
  other: 'Open Seats',
};

// ═══════════════════════════════════════════════════════════════════════════════
// THE STAKES LADDER
// ═══════════════════════════════════════════════════════════════════════════════

/** Blinds are decimals; compare them at a fixed precision, never as floats. */
function bbKey(bb: number): number {
  return Math.round(bb * 10000) / 10000;
}

/**
 * The rungs this club actually runs for one game, ascending.
 *
 * DERIVED FROM THE CLUB, NOT FROM A CONSTANT. A hard-coded ladder
 * (0.05/0.10, 0.10/0.25, 0.25/0.50 ...) is a guess about somebody else's room:
 * "one level lower" has to mean the next stake a player can actually sit down
 * at HERE, and a club that runs 1/2 and 5/10 with nothing between them has 5/10
 * as the neighbour of 1/2 whatever a canonical ladder says. Building it from
 * the candidate set makes the answer true by construction and needs no
 * maintenance when a club adds a rung.
 *
 * The current table's own big blind is included even when no other table shares
 * it, so the player always has a position on their own ladder.
 */
export function stakeLadderFor(
  candidates: ReadonlyArray<QuickJoinCandidate>,
  variant?: string | null,
  currentBigBlind?: number | null
): number[] {
  const rungs = new Set<number>();
  const cur = Number(currentBigBlind);
  if (Number.isFinite(cur) && cur > 0) rungs.add(bbKey(cur));
  for (const c of candidates || []) {
    if (!c) continue;
    if (variant != null && !isSameVariant(c.variant, variant)) continue;
    const bb = Number(c.bigBlind);
    if (Number.isFinite(bb) && bb > 0) rungs.add(bbKey(bb));
  }
  return Array.from(rungs).sort((a, b) => a - b);
}

/**
 * How many rungs `to` sits above `from` on this ladder. Negative is lower,
 * positive is higher, null when either stake is not on the ladder at all
 * (unknown or unparseable blinds — which must not be read as "the same rung").
 */
export function rungOffset(
  ladder: ReadonlyArray<number>,
  from?: number | null,
  to?: number | null
): number | null {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  const ia = ladder.indexOf(bbKey(a));
  const ib = ladder.indexOf(bbKey(b));
  if (ia < 0 || ib < 0) return null;
  return ib - ia;
}

export function tierFor(
  candidate: QuickJoinCandidate,
  favorites: ReadonlySet<string>,
  currentTable?: QuickJoinCurrentTable | null,
  ladder: ReadonlyArray<number> = []
): QuickJoinTier {
  if (favorites.has(candidate.id)) return 'favorite';
  if (!currentTable) return 'other';
  if (!isSameVariant(candidate.variant, currentTable.variant)) return 'other';

  const offset = rungOffset(ladder, currentTable.bigBlind, candidate.bigBlind);
  // Unreadable blinds on the right game are still the right game — they fall
  // to 'same-game' rather than being promoted or thrown out.
  if (offset === null) return 'same-game';
  if (offset === 0) return 'exact';
  if (offset === 1 || offset === -1) return 'adjacent';
  return 'same-game';
}

/** The label a row carries, including which way an adjacent table sits. */
function reasonFor(tier: QuickJoinTier, offset: number | null): string {
  if (tier !== 'adjacent') return TIER_REASON[tier];
  return offset === 1 ? 'One Level Up' : 'One Level Down';
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

  /* The ladder is built from the candidates that SURVIVE exclusion, so a table
     already open in another tab does not invent a rung the player cannot go
     to -- otherwise "one level up" could point at a game they are sitting in. */
  const eligible = (candidates || []).filter((c) => c && c.id && !excluded.has(c.id));
  const ladder = stakeLadderFor(eligible, currentTable?.variant, currentTable?.bigBlind);

  const ranked = eligible.map<RankedQuickJoinTable>((c) => {
    const tier = tierFor(c, favorites, currentTable, ladder);
    const offset = currentTable ? rungOffset(ladder, currentTable.bigBlind, c.bigBlind) : null;
    return { ...c, tier, reason: reasonFor(tier, offset), seatsOpen: seatsOpenOf(c) };
  });

  ranked.sort((a, b) => {
    // 1. Tier: favourites, then the same game at the same stakes, then one
    //    rung either way, then the same game anywhere, then the rest.
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
