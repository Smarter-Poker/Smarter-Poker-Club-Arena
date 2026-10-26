/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BETTING STRUCTURE (client mirror)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Client-side twin of server/src/engine/BettingStructure.ts, kept the same way
 * src/config/RakeConfig.ts mirrors the server copy. The SERVER is authoritative
 * for every wager; this exists so the UI draws the right controls — a slider for
 * no-limit and pot-limit, a single fixed-size button for limit — instead of
 * offering a range the server will then reject.
 *
 * This is a PARTIAL mirror on purpose: it carries only what the browser calls.
 * The first version also exported FIXED_LIMIT_MAX_WAGERS, isPotLimitVariant and
 * a structureBadge() helper for symmetry with the server module, and nothing
 * imported any of them — three dead exports shipped in the name of parity. The
 * cap count and the pot-limit test are enforced server-side, where the rule
 * actually lives; a client copy of a rule the client never asks is not parity,
 * it is a second place for the rule to go stale. Add a function here when a
 * component needs it, not before.
 *
 * Any change here must be made in the server module too.
 *
 * ── STAKES CONVENTION ────────────────────────────────────────────────────────
 * Fixed-limit games are posted by BET size, not blind size. A table storing
 * small_blind 1 / big_blind 2 is a "2/4" limit game: small bet 2 (preflop and
 * flop), big bet 4 (turn and river). `stakesLabel()` is the single place that
 * decides how a table's stakes read, so lobby rows, table headers and the
 * create-table flow cannot disagree about it.
 */

export type BettingStructure = 'no_limit' | 'pot_limit' | 'fixed_limit';

const POT_LIMIT_VARIANTS = new Set(['plo4', 'plo5', 'plo6', 'plo8']);
const FIXED_LIMIT_VARIANTS = new Set(['flh', 'flo8']);

export function bettingStructureFor(variant?: string | null): BettingStructure {
  const v = (variant || '').toLowerCase();
  if (FIXED_LIMIT_VARIANTS.has(v)) return 'fixed_limit';
  if (POT_LIMIT_VARIANTS.has(v) || v.startsWith('plo')) return 'pot_limit';
  return 'no_limit';
}

export function isFixedLimitVariant(variant?: string | null): boolean {
  return bettingStructureFor(variant) === 'fixed_limit';
}

/**
 * The one legal wager for a fixed-limit street: the big blind (small bet) on
 * preflop and flop, twice it (big bet) on turn and river.
 */
export function fixedLimitBetSize(bigBlind: number, street?: string | null): number {
  const s = (street || 'preflop').toLowerCase();
  if (s === 'turn' || s === 'river' || s === 'showdown') return bigBlind * 2;
  return bigBlind;
}

/** How a table's stakes read to a player: bet sizes for limit, blinds otherwise. */
/**
 * The number a stakes sort orders a cash game by: the LARGER figure its
 * stakesLabel prints (2026-10-24). A no-limit or pot-limit "1/2" is blinds
 * 1/2; a fixed-limit "1/2" is blinds 0.50/1 posted as 1/2 bets. Sorting limit
 * rows by their raw big blind put that "1/2" half a level below the label it
 * prints, so on the ALL tab's High To Low a "1/2" FLH appeared again after the
 * whole 0.50/1 group - the split Dan ruled out on 2026-10-23 ("DISPLAY ALL THE
 * 1/2 GAMES FIRST ... AND THEN DO THE .50/1.00 GAME SAME WAY"). Within one
 * betting structure the order is unchanged (a constant factor).
 */
export function stakesSortValue(bigBlind: number, variant?: string | null): number {
  const bb = Number(bigBlind) || 0;
  return isFixedLimitVariant(variant) ? bb * 2 : bb;
}

export function stakesLabel(smallBlind: number, bigBlind: number, variant?: string | null): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  if (isFixedLimitVariant(variant)) return `${fmt(bigBlind)}/${fmt(bigBlind * 2)}`;
  return `${fmt(smallBlind)}/${fmt(bigBlind)}`;
}
