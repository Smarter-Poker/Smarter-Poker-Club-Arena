/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND SPIN'S SETTLEMENT IS ITS OWN DRAW (DIAMOND PHASE 9, 2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `proveTournamentLaunchSetup` will not admit a paid Spin to RUNNING until its
 * row and its settlement name the same launch. A chip Spin's settlement is its
 * one `jackpot_draw` row in the owner's reserve ledger. A Diamond Spin has no
 * owner pool and writes no such row, so that read refused every Diamond Spin
 * before RUNNING, fresh or recovered after a bust.
 *
 * A Diamond Spin's settlement is its immutable draw receipt, read back against
 * the tournament row, its ledger legs and the reserve source's register rows
 * by `fn_poker_diamond_spin_draw_proof`, the same proof the launch completion
 * reads. This is the chip rule with that proof in place of the ledger row:
 * one proven draw, a positive multiplier the manager's own copy and the
 * re-read row both carry, and a prize pool of the buy-in times that multiplier
 * on the proof, the re-read row and the manager's copy alike. A Diamond Spin
 * books no rake, so there is no rake to compare.
 */
export interface DiamondSpinSettlementFacts {
  /** The answer of `fn_poker_diamond_spin_draw_proof`. */
  proof: unknown;
  /** The tournament's buy-in, in Diamonds. */
  buyIn: number;
  /** The manager's own copy of the row, patched from the funded receipt. */
  cachedMultiplier: unknown;
  cachedPrizePool: unknown;
  /** The row as it was just re-read from the database. */
  rowMultiplier: unknown;
  rowPrizePool: unknown;
}

export function diamondSpinSettlementProven(facts: DiamondSpinSettlementFacts): boolean {
  const proof = facts.proof as { ok?: unknown; multiplier?: unknown; prize_pool?: unknown } | null;
  const drawnMultiplier = Number(proof?.multiplier);
  const expectedPrizePool = Math.round(facts.buyIn * drawnMultiplier * 100) / 100;
  return (
    proof?.ok === true &&
    Number.isFinite(drawnMultiplier) &&
    drawnMultiplier > 0 &&
    drawnMultiplier === Number(facts.cachedMultiplier) &&
    Number(facts.rowMultiplier) === drawnMultiplier &&
    Number(proof?.prize_pool) === expectedPrizePool &&
    Number(facts.rowPrizePool) === expectedPrizePool &&
    Number(facts.cachedPrizePool) === expectedPrizePool
  );
}
