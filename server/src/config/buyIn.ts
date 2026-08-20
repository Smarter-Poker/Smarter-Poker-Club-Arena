/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT BUY-INS (server mirror of src/utils/buyIn.ts)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The rule, in full, lives in src/utils/buyIn.ts. The short version:
 *
 *   total  — what the player pays. A whole number off BUY_IN_LADDER.
 *   fee    — DEFAULT_RAKE_RATE of the total  -> tournaments.buy_in_fee
 *   prize  — total - fee                     -> tournaments.buy_in_amount
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

export const BUY_IN_LADDER = [
  1, 2, 3, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 5000,
] as const;

export interface BuyInSplit {
  total: number;
  prize: number;
  fee: number;
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
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
  const fee = cents(t * rakeRate);
  // Subtraction, not a second independent rounding — otherwise prize + fee can
  // miss total by a cent, and money that does not reconcile is a real bug.
  return { total: t, prize: cents(t - fee), fee };
}

/** Snap, then split. Every generator calls THIS. */
export function buyInFor(amount: number, rakeRate: number = DEFAULT_RAKE_RATE): BuyInSplit {
  return splitBuyIn(snapToWholeBuyIn(amount), rakeRate);
}
