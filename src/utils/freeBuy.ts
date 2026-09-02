/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FREEROLLS ARE FREE BUY (Dan, 2026-09-02, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "FREE ROLLS MUST ALWAYS BE SET AS 'FREE BUY'. ITS FREE TO
 * ENTER, $0 BUY IN, BUT REBUYS AND ADD ON'S COST $1. MAKE SURE THAT IS BAKED IN
 * HOW EVER ITS NEEDED."
 *
 * This is the client half of the rule. The server half is
 * server/src/config/buyIn.ts (freeBuyColumns) and the database backstop is the
 * zz_freerolls_are_free_buy trigger (migration 20260902183602). All three
 * agree on the predicate and the numbers; if you change one, change them
 * together (tests/law/FreerollsAreFreeBuy.law.test.ts pins it).
 *
 * The predicate: 0 to enter, and an MTT-family event. A Spin's price is its
 * ladder and an SNG with no prize side is a misconfigured duel, so neither is
 * ever a freeroll. Satellites and bounty formats with a 0 buy-in are.
 */

/** What a rebuy costs in a freeroll. One chip. */
export const FREE_BUY_REBUY_COST = 1;
/** What an add-on costs in a freeroll. One chip. */
export const FREE_BUY_ADDON_COST = 1;
/** Levels the rebuy window stays open on a freeroll (tournaments.rebuy_levels default). */
export const FREE_BUY_REBUY_LEVELS = 4;
/** Levels the add-on window stays open after the rebuy cutoff (tournaments.addon_levels default). */
export const FREE_BUY_ADDON_LEVELS = 1;

/** The badge and the buy-in cell. Title Case Every Word, no em dashes. */
export const FREE_BUY_LABEL = 'Free Buy';
/** The one line under a locked rebuy/add-on control. */
export const FREE_BUY_HELPER = 'Freerolls Are Free To Enter. Rebuys And Add-Ons Cost 1 Chip.';

/** Config-side type names that are never freerolls, whatever the buy-in. */
const NEVER_FREE_BUY_TYPES = new Set(['spin', 'sng', 'spins']);

export interface FreeBuySubject {
  /** Total the player pays to enter (prize + fee). 0 is a freeroll. */
  buyIn: number;
  /**
   * The creation config's `type` ('mtt' | 'bounty' | 'satellite' | 'spin' |
   * 'sng' | ...) or a tournaments row's variant. Case-insensitive.
   */
  type?: string | null;
  /** tournaments.tournament_type when known ('MTT' | 'SNG' | 'SPIN'). */
  tournamentType?: string | null;
}

/** Mirror of fn_is_free_buy_event: is this event a freeroll under the rule? */
export function isFreeBuyEvent(subject: FreeBuySubject): boolean {
  const total = Number(subject.buyIn);
  if (!Number.isFinite(total) || total !== 0) return false;
  const tournamentType = String(subject.tournamentType ?? 'MTT').toUpperCase();
  if (tournamentType !== 'MTT') return false;
  const type = String(subject.type ?? 'mtt').toLowerCase();
  return !NEVER_FREE_BUY_TYPES.has(type);
}

/** Positive whole number of chips, else 0. Local so this module has no imports. */
function whole(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v);
}

/**
 * The camelCase config keys a freeroll MUST carry. Shape-compatible with
 * TournamentService.TournamentConfig, tournamentFromTableConfig's output and
 * the object buildRpcConfig sends to fn_create_tournament.
 */
export interface FreeBuyConfig {
  isRebuy: true;
  isReentry: true;
  addOnAvailable: true;
  rebuyCost: typeof FREE_BUY_REBUY_COST;
  addOnCost: typeof FREE_BUY_ADDON_COST;
  rebuyChips: number;
  addOnChips: number;
  rebuyLevels: number;
  addOnLevels: number;
  maxRebuys?: number;
}

export interface FreeBuyInput extends FreeBuySubject {
  startingStack: number;
  rebuyChips?: number | null;
  addOnChips?: number | null;
  rebuyLevels?: number | null;
  addOnLevels?: number | null;
  maxRebuys?: number | null;
}

/**
 * The keys to spread over a creation config LAST, so they win. Empty when the
 * event is not a freeroll, so it is safe to spread unconditionally.
 *
 * `maxRebuys` is passed through only when it is a positive count: the rebuy
 * RPC reads a NOT NULL 0 as "Rebuy limit reached (0 of 0)", which would deny
 * every freeroll rebuy.
 */
/* Returned as Partial so a caller can spread it over an object literal that
   already names these keys: TypeScript (TS2783) refuses a spread that would
   DEFINITELY overwrite an earlier key, and "definitely" is the point here. */
export function freeBuyConfig(input: FreeBuyInput): Partial<FreeBuyConfig> {
  if (!isFreeBuyEvent(input)) return {};
  const stack = whole(input.startingStack) || 10000;
  const maxRebuys = whole(input.maxRebuys);
  const out: FreeBuyConfig = {
    isRebuy: true,
    isReentry: true,
    addOnAvailable: true,
    rebuyCost: FREE_BUY_REBUY_COST,
    addOnCost: FREE_BUY_ADDON_COST,
    rebuyChips: whole(input.rebuyChips) || stack,
    addOnChips: whole(input.addOnChips) || stack,
    rebuyLevels: whole(input.rebuyLevels) || FREE_BUY_REBUY_LEVELS,
    addOnLevels: whole(input.addOnLevels) || FREE_BUY_ADDON_LEVELS,
  };
  if (maxRebuys > 0) out.maxRebuys = maxRebuys;
  return out;
}

/**
 * The snake_case tournaments columns for a direct insert (HorseOrchestrator).
 * Same rule, database spelling.
 */
export function freeBuyColumns(input: FreeBuyInput): Record<string, unknown> {
  const cfg = freeBuyConfig(input);
  if (cfg.isRebuy !== true) return {};
  return {
    buy_in_fee: 0,
    is_rebuy: true,
    is_reentry: true,
    add_on_available: true,
    rebuy_cost: cfg.rebuyCost,
    addon_cost: cfg.addOnCost,
    rebuy_chips: cfg.rebuyChips,
    addon_chips: cfg.addOnChips,
    rebuy_levels: cfg.rebuyLevels,
    addon_levels: cfg.addOnLevels,
    max_rebuys: cfg.maxRebuys ?? null,
  };
}
