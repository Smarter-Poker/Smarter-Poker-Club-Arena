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
 *   fee    — the house cut, DEFAULT_RAKE_RATE of the total, ROUNDED TO A WHOLE.
 *   prize  — total - fee. What reaches the prize pool. Also whole.
 *
 * `total` is the input; the other two are derived and never authored by hand.
 * The two-numbers-that-must-agree problem disappears with them.
 *
 * ALL THREE ARE WHOLE (Dan 2026-08-20, second pass): "Sit and Go and any
 * tournament buy-ins must never be decimal buy-ins, whole numbers only." The
 * first pass made only the TOTAL whole, which still left a 15 game splitting
 * into 13.50 + 1.50 and printing those decimals on the lobby card, the details
 * page and the register button. The fee is now rounded to a whole number and
 * the prize is what remains, so every money figure a tournament surface shows
 * is an integer and prize + fee still equals total exactly.
 *
 * The cost of that is fee granularity at the bottom of the ladder: a 1/2/3
 * total rounds to a zero fee (the house takes nothing on a micro game rather
 * than a fraction of a chip) and a 5/15/25/75 total rounds its fee up (so 5
 * pays 1 rather than 0.50). That is deliberate — a whole number of chips that
 * reconciles beats a decimal that is technically 10%.
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
 * arbitrary.
 *
 * The fee is a whole number at every rung (splitBuyIn rounds it), so the low
 * rungs are not exactly 10%: 1/2/3 round down to a 0 fee and 5/15/25/75 round
 * up. That is the deliberate trade — see the header. Note this ladder governs
 * the GENERATORS only; an owner creating a game by hand may price it at any
 * positive whole number.
 */
export const BUY_IN_LADDER = [
  1, 2, 3, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 5000,
] as const;

export interface BuyInSplit {
  /** What the player pays. Always a whole number. */
  total: number;
  /** Goes to the prize pool -> tournaments.buy_in_amount. Always whole. */
  prize: number;
  /** House cut -> tournaments.buy_in_fee. Always whole. */
  fee: number;
}

/** Round to cents without float drift (0.1 * 3 = 0.30000000000000004). */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The one gate every tournament/SNG money field goes through: a positive whole
 * number of chips, or 0 for a freeroll. Anything fractional, negative, NaN or
 * Infinite collapses to a whole number rather than being allowed through.
 */
export function wholeChips(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v);
}

/**
 * Validation backstop for creation forms. `''` and `'12.5'` are both rejected;
 * only a positive integer passes. The forms also block decimal ENTRY, so this
 * should never fire in normal use.
 */
export function isWholeBuyIn(value: unknown): boolean {
  const v = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value)) : Number(value);
  return Number.isInteger(v) && v > 0;
}

/**
 * Change handler for a whole-number money input. Strips everything that is not
 * a digit, so a decimal point cannot be typed or pasted in the first place, and
 * drops leading zeroes so "0050" cannot be submitted.
 */
export function digitsOnly(value: string): string {
  const stripped = String(value ?? '').replace(/[^0-9]/g, '');
  const trimmed = stripped.replace(/^0+(?=\d)/, '');
  return trimmed;
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
  // WHOLE fee, not a cent-rounded one: see the header. A 15 total takes a 2
  // fee, not 1.50, so nothing downstream ever has a decimal to print.
  // Dan 2026-08-21: EVERY buy-in pays the registration fee. round(4 * 0.1)
  // is 0, so small buy-ins were entering rake-free; a positive total now
  // always carries at least one chip of fee. A freeroll (0) returns above
  // and stays 0/0.
  const fee = Math.min(t, Math.max(1, Math.round(t * rakeRate)));
  // prize is computed by SUBTRACTION, never by its own rounding. Rounding both
  // ends independently is how prize + fee stops equalling total, and money that
  // does not reconcile on a money surface is a real bug later.
  return { total: t, prize: t - fee, fee };
}

/** Snap first, then split. What every tournament generator should call. */
export function buyInFor(amount: number, rakeRate: number = DEFAULT_RAKE_RATE): BuyInSplit {
  return splitBuyIn(snapToWholeBuyIn(amount), rakeRate);
}

/**
 * Tournament money always prints as a whole number.
 *
 * Dan 2026-08-20: no decimal buy-ins anywhere. New games are created whole end
 * to end, but the ~9.8k pre-2026-08-20 rows are settled financial history that
 * the migration deliberately did NOT rewrite, so they still carry 19.8 / 5.5 /
 * 13.5. Rounding at the render is what keeps those off the screen without
 * falsifying the ledger they came from.
 */
export function money(n: number): string {
  const v = Number(n);
  return (Number.isFinite(v) ? Math.round(v) : 0).toLocaleString('en-US');
}

/** The total a player pays, from the two stored columns. Always whole. */
export function totalBuyIn(prize: number, fee: number | null | undefined): number {
  return Math.round(cents((Number(prize) || 0) + (Number(fee) || 0)));
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
  // Round the FEE and take the prize as the remainder, rather than rounding
  // both ends. Rounding each independently is how a legacy 13.5 + 1.5 row
  // renders as "15 (14 + 2)" and the parts stop adding up to the total.
  const shownFee = Math.min(total, Math.max(0, Math.round(f)));
  return `${money(total)} (${money(total - shownFee)} + ${money(shownFee)})`;
}

/** Compact form for a narrow lobby card: just the total. */
export function formatBuyInShort(prize: number, fee: number | null | undefined): string {
  const total = totalBuyIn(Number(prize) || 0, fee);
  return total <= 0 ? 'FREE' : money(total);
}
