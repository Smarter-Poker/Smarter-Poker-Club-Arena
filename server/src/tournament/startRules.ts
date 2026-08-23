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
 * The minimum field a tournament may start with.
 *
 * History: this was a hard-coded 3 inside start(). The 2026-08-22 parity work
 * added 2-seat Heads-Up SNGs — which are FULL at two players — and the first
 * Heads-Up Hyper Duel spawned by the scheduler sat REGISTERING for hours:
 * 2/2 seated, GameServer's discovery said start, the floor said stand down,
 * and the interval scheduler saw a live instance so it never spawned another.
 * The whole Heads-Up lane was dead behind one constant.
 *
 * The floor is the smaller of 3 and the field's own max_players, never below
 * 2 — poker needs an opponent, and a 3+ seat game still waits for 3.
 */
export function startFloorFor(maxPlayers: unknown): number {
  const max = Number(maxPlayers);
  if (!Number.isFinite(max) || max <= 0) return 3;
  return Math.max(2, Math.min(3, Math.floor(max)));
}

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
