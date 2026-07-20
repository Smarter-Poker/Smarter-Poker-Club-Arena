/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SEVEN-DEUCE BOUNTY (7-2 game) — pure computation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The 7-2 game: a player who WINS a pot holding any 7 and any 2 collects a fixed
 * bounty from every OTHER player dealt into that hand. Rules (Dan 2026-07-20):
 *   - The hand MUST have seen a flop to qualify (gated by the caller).
 *   - Any 7 + any 2 qualifies.
 *   - Default bounty is 2 big blinds per paying player (configurable per table).
 *
 * The bounty is a player-to-player table-stack transfer. It is ZERO-SUM and
 * chip-conserving: each payer pays at most their remaining stack, and the winner
 * receives exactly the sum actually collected — no chips are ever minted. This
 * module is pure (no I/O, no engine mutation) so the money math is unit-testable;
 * the caller applies the returned transfers to the live stacks.
 */

export interface SevenDeucePlayerState {
  userId: string;
  cards: Array<{ rank: string }>;
  /** Current (post-pot-award) table stack in chips. */
  stack: number;
}

export interface SevenDeuceTransfer {
  winnerUserId: string;
  /** Total chips actually collected for this winner (sum of payer amounts). */
  totalCollected: number;
  /** The nominal per-payer bounty before stack-capping. */
  perPlayerAmount: number;
  /** Each payer and the amount they actually paid (capped at their stack). */
  payers: Array<{ userId: string; amount: number }>;
}

/** True when the hole cards contain at least one 7 and at least one 2. */
export function isSevenTwo(cards: Array<{ rank: string }> | undefined | null): boolean {
  if (!cards || cards.length === 0) return false;
  const has7 = cards.some((c) => c?.rank === '7');
  const has2 = cards.some((c) => c?.rank === '2');
  return has7 && has2;
}

/** Round to whole cents to avoid floating-point drift on chip amounts. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the 7-2 bounty transfers for a completed hand.
 *
 * @param winnerIds       user IDs that won a share of the pot this hand
 * @param dealtIn         every dealt-in player with post-pot stack + hole cards
 * @param bountyPerPayer  chips each non-winner owes a qualifying winner
 *                        (already computed as bbMultiple * bigBlind, rounded)
 * @returns one transfer per qualifying (7-2-holding) winner that collected > 0.
 *          Empty when no winner holds 7-2 or nothing could be collected.
 *
 * NOTE ON PAYER STACKS: `dealtIn` stacks are treated as read-only here. When two
 * qualifying winners exist (a chop where more than one holds a 7 and a 2), each
 * is computed against the SAME snapshot, so a payer's obligation to each winner
 * is independent. The caller applies debits sequentially and must not let a
 * stack go negative — which it cannot, because the caller re-reads the live
 * stack and caps again at apply time. In the overwhelmingly common single-winner
 * case this is exact.
 */
export function computeSevenDeuceBounties(
  winnerIds: string[],
  dealtIn: SevenDeucePlayerState[],
  bountyPerPayer: number
): SevenDeuceTransfer[] {
  const transfers: SevenDeuceTransfer[] = [];
  if (bountyPerPayer <= 0 || winnerIds.length === 0 || dealtIn.length === 0) {
    return transfers;
  }

  const byId = new Map(dealtIn.map((p) => [p.userId, p]));

  for (const winnerId of winnerIds) {
    const winner = byId.get(winnerId);
    if (!winner || !isSevenTwo(winner.cards)) continue;

    let collected = 0;
    const payers: Array<{ userId: string; amount: number }> = [];
    for (const payer of dealtIn) {
      if (payer.userId === winnerId) continue;
      const avail = Math.max(0, round2(payer.stack));
      const pay = Math.min(round2(bountyPerPayer), avail);
      if (pay <= 0) continue;
      collected = round2(collected + pay);
      payers.push({ userId: payer.userId, amount: pay });
    }

    if (collected > 0) {
      transfers.push({
        winnerUserId: winnerId,
        totalCollected: collected,
        perPlayerAmount: round2(bountyPerPayer),
        payers,
      });
    }
  }

  return transfers;
}
