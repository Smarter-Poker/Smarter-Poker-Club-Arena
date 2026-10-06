/**
 * ═══ THE DIAMOND CASH HAND SENDS ITS RAKE FACTS ══════════════════════════
 *
 * Migration 20261005183028_diamond_cash_rake_reads_the_owner_settings made
 * `fn_poker_diamond_settle_cash_hand` recompute the rake from the owner's
 * published Diamond economics instead of taking the engine's number on trust.
 * To recompute it, the settler needs three facts it cannot derive from the
 * stacks, and the router `fn_ca_settle_hand_stacks_absolute` forwards the
 * stacks payload unchanged, so the facts ride on every element of it:
 *
 *   contributed    whole Diamonds this player put into the pot and did not get
 *                  back as an uncalled bet. The pot is their sum.
 *   dealt_in       whether this player was dealt a hand. Their count is the
 *                  "dealt" bracket that picks the percent and the cap.
 *   hand_saw_flop  whether a flop was dealt. A fact about the HAND, so it
 *                  rides on every element and they must agree.
 *
 * WHENEVER THE RAKE SWITCH IS ON - not merely when the rake is non-zero - a
 * hand that arrives without them is refused by name
 * (`diamond_cash_rake_facts_required`). The switch reads `yes` on production
 * today, so without this module every Diamond cash hand refuses the moment
 * `cash_games_enabled` opens.
 *
 * NO SECOND ACCOUNTING OF THE POT. None of the three is computed here. Each
 * is read from the one place the engine already keeps it:
 *
 *   contributed    `currentHandContributions` - the engine's own
 *                  `totalInvested` per player, captured at WINNERS and already
 *                  net of a returned uncalled bet. It is the same map that
 *                  feeds `atomic_distribute_rake`'s WEIGHTED_CONTRIBUTED
 *                  attribution on the chip path, and the settler attributes
 *                  the Diamond rake by the same method, so the two paths
 *                  weight the rake off ONE number.
 *   dealt_in       `currentHandDealtStacks` - what every dealt player held
 *                  when the cards went out, keyed by user id. Membership of
 *                  that map IS having been dealt a hand.
 *   hand_saw_flop  `HandController.handSawFlopForMoney()` - the exact
 *                  expression `priceDeductions` already prices rake with
 *                  (the flag AND a board that corroborates it). One
 *                  definition, two readers.
 *
 * WHOLE DIAMONDS ONLY. A Diamond is indivisible. A fractional contribution on
 * a Diamond table is a defect in whatever produced it, and rounding it here
 * would turn a wrong contribution into a wrong rake - rake is money - so it
 * is refused by name at this boundary instead, in the shape
 * DiamondCashBoundary already uses.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). There is no `is_horse` in this file and
 * no branch that could grow one: a horse's seat is read from the same two maps
 * as a person's.
 */

/** The three keys, exactly as the settler's roster check requires them. */
export interface DiamondCashRakeFacts {
  contributed: number;
  dealt_in: boolean;
  hand_saw_flop: boolean;
}

/**
 * A Diamond is indivisible, so a contribution is a whole number. Float dust
 * from the engine's running sums is removed at the cent scale every other
 * money value in settlement is normalised at; anything still fractional after
 * that is a real fraction and is refused, never rounded.
 */
function wholeDiamondsContributed(raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new Error('atomic hand commit refused (diamond_whole_contribution_required)');
  }
  const atCentScale = Math.round(raw * 100) / 100;
  if (!Number.isSafeInteger(atCentScale) || atCentScale < 0 || atCentScale > 2147483647) {
    throw new Error('atomic hand commit refused (diamond_whole_contribution_required)');
  }
  return atCentScale;
}

/**
 * The three facts for one seat of one Diamond cash hand.
 *
 * `handSawFlop` is the HAND's fact and is passed in whole, so every element
 * this builds carries the same value by construction - the settler refuses a
 * payload whose elements disagree, and a payload built here cannot disagree.
 */
export function diamondCashRakeFactsFor(input: {
  userId: string;
  contributions: ReadonlyMap<string, number>;
  dealtStacks: ReadonlyMap<string, number>;
  handSawFlop: boolean;
}): DiamondCashRakeFacts {
  const contributed = wholeDiamondsContributed(input.contributions.get(input.userId) ?? 0);
  const dealtIn = input.dealtStacks.has(input.userId);
  /* A PLAYER WHO CONTRIBUTED CANNOT HAVE BEEN SITTING OUT. The settler says
     this too (`diamond_cash_rake_facts_disagree`), and it is right to. Said
     here as well because the two maps are built from one deal roster, so a
     disagreement between them is an engine defect that should arrive named at
     the boundary that produced it rather than as a refused hand. */
  if (contributed > 0 && !dealtIn) {
    throw new Error('atomic hand commit refused (diamond_contribution_without_a_dealt_hand)');
  }
  return {
    contributed,
    dealt_in: dealtIn,
    hand_saw_flop: input.handSawFlop === true,
  };
}
