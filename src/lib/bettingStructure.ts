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

/** One bet plus three raises per street. Preflop the blind is the bet. */
export const FIXED_LIMIT_MAX_WAGERS = 4;

export function bettingStructureFor(variant?: string | null): BettingStructure {
  const v = (variant || '').toLowerCase();
  if (FIXED_LIMIT_VARIANTS.has(v)) return 'fixed_limit';
  if (POT_LIMIT_VARIANTS.has(v) || v.startsWith('plo')) return 'pot_limit';
  return 'no_limit';
}

export function isFixedLimitVariant(variant?: string | null): boolean {
  return bettingStructureFor(variant) === 'fixed_limit';
}

export function isPotLimitVariant(variant?: string | null): boolean {
  return bettingStructureFor(variant) === 'pot_limit';
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
export function stakesLabel(smallBlind: number, bigBlind: number, variant?: string | null): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  if (isFixedLimitVariant(variant)) return `${fmt(bigBlind)}/${fmt(bigBlind * 2)}`;
  return `${fmt(smallBlind)}/${fmt(bigBlind)}`;
}

/** Short badge shown next to a game name, e.g. "FL" on a limit table. */
export function structureBadge(variant?: string | null): 'NL' | 'PL' | 'FL' {
  switch (bettingStructureFor(variant)) {
    case 'fixed_limit':
      return 'FL';
    case 'pot_limit':
      return 'PL';
    default:
      return 'NL';
  }
}
