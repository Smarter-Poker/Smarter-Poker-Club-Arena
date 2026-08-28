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
 * guarantee, whichever is larger.
 *
 * DISPLAY ONLY. DO NOT WIRE THIS BACK INTO A WRITE PATH (2026-08-27).
 *
 * The three engine sites that closed a prize pool used to compute this max and
 * UPDATE `tournaments.prize_pool` with it. That is not applying a guarantee, it
 * is inventing chips: no treasury was debited, no overlay row was written, and
 * the difference was then paid to real wallets. 2,823 completed guaranteed
 * events carry no overlay row, 1,492 of them accounting for 98,253.32 chips,
 * and one club treasury went negative. Every one of those sites now calls
 * `fn_apply_prize_guarantee`, which moves the money and returns the pool —
 * see `TournamentManagerBase.applyPrizeGuarantee`.
 *
 * This function survives because the CLIENT shows the advertised pool before
 * the guarantee is funded, and because the arithmetic is still worth pinning.
 * Nothing on the server may write its result.
 */
export function effectivePrizePool(prizePool: unknown, guaranteedPrize: unknown): number {
  const pool = Number(prizePool);
  const gtd = Number(guaranteedPrize);
  return Math.max(Number.isFinite(pool) ? pool : 0, Number.isFinite(gtd) ? gtd : 0);
}
