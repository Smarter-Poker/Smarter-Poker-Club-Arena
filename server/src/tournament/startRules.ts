/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  START RULES — tiny pure predicates the tournament start path pins tests on
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Zero imports on purpose (same reasoning as payoutStructure.ts): these feed
 * money- and lifecycle-critical branches inside TournamentManagerBase, and a
 * pure module with no edges can be unit-tested without booting supabase.
 */

/**
 * NOTE (2026-08-23): this module used to also export `startFloorFor`, the
 * min(3, max_players) rule that let a 2-seat Heads-Up game start. That rule
 * landed on main independently as an inline expression in
 * TournamentManagerBase (#424, "a heads-up game is not short of players, it
 * is full"), so keeping a second copy here would mean two sources of truth
 * for one rule and a helper nobody calls - the precise trap this session
 * documented twice (TournamentHUD, lazyWithRetry). The live version is the
 * one in TournamentManagerBase; this file keeps only what is still unique.
 */

/**
 * The pool a tournament actually pays: the accrued entries or the advertised
 * guarantee, whichever is larger. The recurring service pre-applied this at
 * creation; scheduled tournaments accrue per-entry through the register RPCs
 * and apply it when the pool stops moving (late-reg close / add-on end, or at
 * start when there is no late registration at all).
 */
export function effectivePrizePool(prizePool: unknown, guaranteedPrize: unknown): number {
  const pool = Number(prizePool);
  const gtd = Number(guaranteedPrize);
  return Math.max(Number.isFinite(pool) ? pool : 0, Number.isFinite(gtd) ? gtd : 0);
}
