/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT BUY-INS (server mirror of src/utils/buyIn.ts)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The rule, in full, lives in src/utils/buyIn.ts. The short version:
 *
 *   total  — what the player pays. A whole number off BUY_IN_LADDER.
 *   fee    — DEFAULT_RAKE_RATE of the total, ROUNDED WHOLE -> tournaments.buy_in_fee
 *   prize  — total - fee, therefore also whole              -> tournaments.buy_in_amount
 *
 * Dan 2026-08-20 (second pass): "Sit and Go and any tournament buy-ins must
 * never be decimal buy-ins, whole numbers only." All THREE numbers are whole
 * now, not just the total — a 15 game is 13 + 2, never 13.50 + 1.50.
 *
 * Rake is a cut OF the buy-in, not a surcharge ON TOP of it. The generator used
 * to store a hand-written `buyIn` and `rake` pair and let the player pay the
 * SUM, so every game was priced at 1.1x a round number — 5.50, 11.00, 19.80,
 * 22.00. Feed the whole-dollar total in here instead and the split comes out
 * the other side.
 *
 * WHY A COPY: server/tsconfig.json sets `rootDir: ./src`, so nothing under
 * server/ can import from the app's src/. Change one file, change both. The
 * CHECK constraint in supabase/migrations/20260820_whole_dollar_tournament_buyins.sql
 * is what actually enforces the rule against BOTH of them.
 */

export const DEFAULT_RAKE_RATE = 0.1;

/**
 * Generator price points. The fee is whole at every rung (splitBuyIn rounds
 * it), so 1/2/3 carry a 0 fee and 5/15/25/75 round their fee up - see
 * src/utils/buyIn.ts for why that trade was made.
 */
export const BUY_IN_LADDER = [
  1, 2, 3, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 5000,
] as const;

export interface BuyInSplit {
  total: number;
  prize: number;
  fee: number;
}

/**
 * The one gate every tournament/SNG money field goes through: a positive whole
 * number of chips, or 0 for a freeroll. Mirror of wholeChips in
 * src/utils/buyIn.ts.
 */
export function wholeChips(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v);
}

/** Snap onto the ladder. Exact ties resolve UPWARD to the recognisable price. */
export function snapToWholeBuyIn(amount: number): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let best: number = BUY_IN_LADDER[0];
  let bestGap = Infinity;
  for (const step of BUY_IN_LADDER) {
    const gap = Math.abs(step - n);
    if (gap <= bestGap) {
      bestGap = gap;
      best = step;
    }
  }
  return best;
}

/** Split a whole total. 0 stays a freeroll: never levy a fee on a free game. */
export function splitBuyIn(total: number, rakeRate: number = DEFAULT_RAKE_RATE): BuyInSplit {
  const t = Math.max(0, Math.round(Number(total) || 0));
  if (t === 0) return { total: 0, prize: 0, fee: 0 };
  /**
   * Dan 2026-08-21 (second batch): "RAKE IS EXCEEDING 10% ON THIS TOURNAMENT."
   *
   * Two earlier rules on this line both pushed the fee ABOVE the cap:
   * `Math.round` turned a 15 total into a 2 fee (13.33%), and the `Math.max(1)`
   * floor — added so micro games could not enter rake-free — made a 5 total pay
   * 20%, a 3 pay 33% and a 1 pay 100%. Every Pre-Dawn Mystery Bounty that ran
   * today was 4 + 1 = 20%.
   *
   * 10% is a ceiling, so the fee FLOORS and no minimum is imposed. A total
   * under 10 therefore takes no rake — that rule cannot coexist with a hard cap
   * while fees are whole numbers, and a breached cap is the worse failure.
   *
   * MIRROR of src/utils/buyIn.ts — change one, change both.
   */
  const fee = Math.min(t, Math.floor(t * rakeRate + 1e-9));
  // Subtraction, not a second independent rounding — otherwise prize + fee can
  // miss total, and money that does not reconcile is a real bug.
  return { total: t, prize: t - fee, fee };
}

/** Snap, then split. Every generator calls THIS. */
export function buyInFor(amount: number, rakeRate: number = DEFAULT_RAKE_RATE): BuyInSplit {
  return splitBuyIn(snapToWholeBuyIn(amount), rakeRate);
}

/**
 * THE CEILING (Dan 2026-08-21): the house never takes more than 10% of what a
 * player pays for a tournament seat. Mirror of src/utils/buyIn.ts; the CHECK
 * constraint in supabase/migrations/20260821_tournament_rake_cap.sql is the
 * backstop for any writer that forgets to call this.
 */
export function rakePctOf(prize: number, fee: number): number {
  const total = Number(prize || 0) + Number(fee || 0);
  if (!(total > 0)) return 0;
  return (Number(fee || 0) / total) * 100;
}

export function isRakeWithinCap(
  prize: number,
  fee: number,
  rakeRate: number = DEFAULT_RAKE_RATE
): boolean {
  return rakePctOf(prize, fee) <= rakeRate * 100 + 1e-9;
}

/**
 * Clamp a (prize, fee) pair onto the cap without changing the total the player
 * pays — only the split moves, so nobody is ever charged more than advertised.
 */
export function clampRakeToCap(
  prize: number,
  fee: number,
  rakeRate: number = DEFAULT_RAKE_RATE
): { prize: number; fee: number } {
  const total = Math.max(0, Math.round(Number(prize || 0) + Number(fee || 0)));
  if (total === 0) return { prize: 0, fee: 0 };
  const capped = Math.min(
    Math.max(0, Math.round(Number(fee || 0))),
    Math.floor(total * rakeRate + 1e-9)
  );
  return { prize: total - capped, fee: capped };
}
