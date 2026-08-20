/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT BUY-INS — one whole-dollar total, split into prize + fee
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "buy ins should always be whole dollars. 20 10 50 5 etc not
 * 19.8 or weird numbers."
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * Every tournament config declared TWO hand-written numbers:
 *
 *     { buyIn: 18, rake: 1.8 }      { buyIn: 5, rake: 0.5 }
 *
 * and stored them as `buy_in_amount` / `buy_in_fee`. But a player does not pay
 * `buy_in_amount` — they pay the SUM. So the advertised buy-in was
 * 18 + 1.80 = 19.80, and 5 + 0.50 = 5.50, and 20 + 2 = 22. Every single
 * tournament on the platform was priced at a number no poker room would ever
 * put on a board.
 *
 * The mistake is which end the rounding happens at. Rake is a CUT OF the
 * buy-in, not a surcharge ON TOP of it. Every real room advertises the total
 * and splits it inward — "$20 (18 + 2)", exactly the notation in the reference
 * screenshot. Add the fee outward and no amount of care picking `buyIn` gets
 * you a round total, because 1.1x a round number essentially never is one.
 *
 * THE RULE
 * --------
 *   total  — what the player pays. A whole number off BUY_IN_LADDER.
 *   fee    — the house cut, DEFAULT_RAKE_RATE of the total.
 *   prize  — total - fee. What reaches the prize pool.
 *
 * `total` is the input; the other two are derived and never authored by hand.
 * The two-numbers-that-must-agree problem disappears with them.
 *
 * MIRROR: server/src/config/buyIn.ts holds the same rule for the tournament
 * generator. The server tsconfig sets `rootDir: ./src`, so it cannot import
 * from this file. Change one, change both — and the DB CHECK constraint added
 * in 20260820_whole_dollar_tournament_buyins.sql is the backstop that fails
 * loudly if a third writer ever appears and disagrees with both.
 */

/** House cut, as a fraction of the total the player pays. */
export const DEFAULT_RAKE_RATE = 0.1;

/**
 * The buy-in levels a tournament may be priced at.
 *
 * Deliberately a fixed ladder rather than "any integer". Dan's examples were
 * "20 10 50 5" — a room advertises recognisable price points, and a generator
 * left free to emit 18 or 37 produces whole numbers that still read as
 * arbitrary. Every entry is divisible into a clean 10% fee.
 */
export const BUY_IN_LADDER = [
  1, 2, 3, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 5000,
] as const;

export interface BuyInSplit {
  /** What the player pays. Always a whole number. */
  total: number;
  /** Goes to the prize pool -> tournaments.buy_in_amount */
  prize: number;
  /** House cut -> tournaments.buy_in_fee */
  fee: number;
}

/** Round to cents without float drift (0.1 * 3 = 0.30000000000000004). */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Snap any amount onto the ladder. Ties go UP: a generator that lands between
 * two price points should advertise the higher, recognisable one rather than
 * quietly discount the game.
 */
export function snapToWholeBuyIn(amount: number): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0; // freeroll
  // Annotated `number`, not inferred: `as const` narrows BUY_IN_LADDER[0] to
  // the literal type 1, and every later assignment then fails to widen.
  let best: number = BUY_IN_LADDER[0];
  let bestGap = Infinity;
  for (const step of BUY_IN_LADDER) {
    const gap = Math.abs(step - n);
    // `<=` makes the LAST (higher) candidate win an exact tie.
    if (gap <= bestGap) {
      bestGap = gap;
      best = step;
    }
  }
  return best;
}

/**
 * Split a whole-dollar total into prize + fee.
 *
 * A total of 0 is a freeroll and stays 0/0 — charging a fee on a free
 * tournament is the one case where deriving the fee would be actively wrong.
 */
export function splitBuyIn(total: number, rakeRate: number = DEFAULT_RAKE_RATE): BuyInSplit {
  const t = Math.max(0, Math.round(Number(total) || 0));
  if (t === 0) return { total: 0, prize: 0, fee: 0 };
  const fee = cents(t * rakeRate);
  // prize is computed by SUBTRACTION, never by its own rounding. Rounding both
  // ends independently is how prize + fee stops equalling total by a cent, and
  // a cent that does not reconcile on a money surface is a real bug later.
  return { total: t, prize: cents(t - fee), fee };
}

/** Snap first, then split. What every tournament generator should call. */
export function buyInFor(amount: number, rakeRate: number = DEFAULT_RAKE_RATE): BuyInSplit {
  return splitBuyIn(snapToWholeBuyIn(amount), rakeRate);
}

/** Whole numbers print bare; anything else keeps exactly two decimals. */
export function money(n: number): string {
  const v = Number(n) || 0;
  return Number.isInteger(v)
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The total a player pays, from the two stored columns. */
export function totalBuyIn(prize: number, fee: number | null | undefined): number {
  return cents((Number(prize) || 0) + (Number(fee) || 0));
}

/**
 * Lobby / details rendering: `20 (18 + 2)`, or `FREE`.
 *
 * The total leads because it is the number the player is deciding on. The
 * split follows in parentheses because where the money goes is the second
 * question, not the first — which is the mistake the old card made when it
 * showed `Buy In 19.8` with no breakdown at all.
 */
export function formatBuyIn(prize: number, fee: number | null | undefined): string {
  const p = Number(prize) || 0;
  const f = Number(fee) || 0;
  const total = totalBuyIn(p, f);
  if (total <= 0) return 'FREE';
  if (f <= 0) return money(total);
  return `${money(total)} (${money(p)} + ${money(f)})`;
}

/** Compact form for a narrow lobby card: just the total. */
export function formatBuyInShort(prize: number, fee: number | null | undefined): string {
  const total = totalBuyIn(Number(prize) || 0, fee);
  return total <= 0 ? 'FREE' : money(total);
}
