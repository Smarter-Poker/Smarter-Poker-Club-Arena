/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT PAYOUT — prize, bounty, total, and the order they belong in
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan sections 37, 42 and 44.
 *
 * A tournament payout has TWO halves and they must stay apart in the record:
 * the placement prize, and everything won off other players' heads. The total is
 * derived at the point of display and never written back over either half, which
 * is why this is a function of a row rather than a field on one.
 *
 * Section 44 is the reason any of this is a module instead of three lines inline:
 * in a mystery bounty event the champion is often NOT the biggest earner of the
 * night, and a results table that sorts and highlights on the placement prize
 * alone reports the wrong person as the winner of the money. The ordering rule
 * and the "who actually took the most" answer are pinned by tests here so a
 * later layout change cannot quietly lose them.
 */

export interface PayoutRow {
  user_id: string;
  /** Placement prize ONLY. */
  prize: number;
  /** Every bounty collected, in the same units as `prize`. */
  bounty_winnings: number;
  position: number | null;
}

/** Placement prize plus every bounty. Section 43. */
export function totalPayout(r: Pick<PayoutRow, 'prize' | 'bounty_winnings'>): number {
  return (Number(r.prize) || 0) + (Number(r.bounty_winnings) || 0);
}

export type ResultSort = 'finish' | 'total';

/**
 * The finishers in the requested order.
 *
 * 'finish' is the default because a tournament result is a PLACE. 'total' exists
 * so the fact that a lower finisher can top the money list is visible rather
 * than implied, and it breaks ties on the finish so two players who took the
 * same money still appear in the order they went out.
 *
 * Returns a new array; the caller's list is never mutated.
 */
export function sortResults<T extends PayoutRow>(rows: readonly T[], sort: ResultSort): T[] {
  const out = [...rows];
  if (sort === 'total') {
    return out.sort(
      (a, b) => totalPayout(b) - totalPayout(a) || (a.position || 999) - (b.position || 999)
    );
  }
  return out.sort((a, b) => (a.position || 999) - (b.position || 999));
}

/** Whoever took the most money out of the event. Null for an empty field. */
export function biggestEarner<T extends PayoutRow>(rows: readonly T[]): T | null {
  return rows.reduce<T | null>(
    (best, r) => (!best || totalPayout(r) > totalPayout(best) ? r : best),
    null
  );
}

/**
 * Did somebody out-earn the champion?
 *
 * False when there is no champion, when the champion IS the biggest earner, and
 * when the two are level - "more than the champion" has to mean strictly more,
 * or a tie would print a banner claiming somebody beat them.
 */
export function bountyBeatTheChampion<T extends PayoutRow>(rows: readonly T[]): boolean {
  const champion = rows.find((r) => r.position === 1);
  const biggest = biggestEarner(rows);
  if (!champion || !biggest) return false;
  if (biggest.user_id === champion.user_id) return false;
  return totalPayout(biggest) > totalPayout(champion);
}
