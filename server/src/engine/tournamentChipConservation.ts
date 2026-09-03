/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tournament chips are not money, but they decide the winner. A cash hand is
 * already held to `stack deltas + rake + bbj = 0` by
 * `fn_ca_settle_hand_stacks_absolute`; a tournament hand was held to nothing,
 * because the engine passes `rake = null` and the database's strict check
 * only runs when rake is declared. This is the engine half of closing that.
 *
 * The identity for a tournament hand is exact: no rake, no BBJ drop, no
 * insurance from a bank, so the players who were dealt in must hold, after
 * settlement, precisely what they held when the cards went out. Anything
 * else means the engine either minted or destroyed chips inside the hand,
 * and the record must not learn a total the engine cannot account for.
 *
 * Pure. The caller (postHandTasks) decides what to do with a refusal: raise
 * the CRITICAL alert and skip the persist, so the pre-hand stacks stay on
 * the record and a hand that does not conserve cannot decide a winner.
 */

export interface DealtStack {
  user_id: string;
  stack: number;
}

export interface TournamentConservationInput {
  /** Stacks handed to the HandController when the hand was dealt. */
  dealt: ReadonlyMap<string, number>;
  /** Stacks the engine intends to persist after settlement. */
  settled: readonly DealtStack[];
  /** Chips that legitimately left the felt this hand. 0 on tournament tables. */
  rake?: number;
}

export interface TournamentConservationVerdict {
  ok: boolean;
  dealtTotal: number;
  settledTotal: number;
  /** settledTotal + rake - dealtTotal. Positive = minted, negative = destroyed. */
  delta: number;
  /** Dealt players the settlement did not carry a stack for. */
  missing: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function checkTournamentChipConservation(
  input: TournamentConservationInput
): TournamentConservationVerdict {
  const rake = num(input.rake);
  let dealtTotal = 0;
  let settledTotal = 0;
  const missing: string[] = [];
  const settledById = new Map<string, number>();
  for (const s of input.settled) settledById.set(s.user_id, num(s.stack));

  for (const [userId, stack] of input.dealt) {
    dealtTotal += num(stack);
    const after = settledById.get(userId);
    if (after === undefined) {
      missing.push(userId);
      continue;
    }
    settledTotal += after;
  }

  dealtTotal = round2(dealtTotal);
  settledTotal = round2(settledTotal);
  const delta = round2(settledTotal + rake - dealtTotal);
  // A dealt player with no settled stack is a hole in the record, not a
  // conserved hand: their chips would vanish from the felt on the next deal.
  return { ok: delta === 0 && missing.length === 0, dealtTotal, settledTotal, delta, missing };
}
