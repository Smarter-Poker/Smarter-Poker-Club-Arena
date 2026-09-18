import { isUnlimitedMtt } from '../../server/src/tournament/tournamentEntryCapacity';
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
import { FREE_BUY_LABEL } from './freeBuy';

/** House cut, as a fraction of the total the player pays. */
export const DEFAULT_RAKE_RATE = 0.1;

/**
 * Dan 2026-08-25: "HEADS UP EVENTS ARE ONLY A 5% RAKE, SO A 1 CHIP BUY IN X 2
 * PLAYERS = 5% OF 2 CHIPS, SO WINNER TAKES ALL = 1.90 PAYOUT."
 */
export const HEADS_UP_RAKE_RATE = 0.05;

/**
 * A Spin charges the buy-in and NOTHING else — its rake is engineered into the
 * multiplier distribution (src/config/spinSpec.ts), and `buy_in_fee` must be 0.
 * A database constraint (tournaments_spin_no_extra_rake) refuses a fee-bearing
 * Spin, so a writer that quotes one is quoting a row the database will reject.
 */
export const SPIN_RAKE_RATE = 0;

/**
 * Enough of a tournament to know what it costs to enter it. Every field is
 * optional because the six creation paths each hold a different subset: a
 * schedule row has `variant`, the owner modal has a format string, the
 * recurring generator has a config with seats.
 */
export interface RakeSubject {
  /** tournaments.tournament_type — 'MTT' | 'SNG' | 'SPIN'. Any case. */
  tournamentType?: string | null;
  satellite_target_id?: string | null;
  satelliteTarget?: { tournamentId?: string } | null;
  /** tournaments.variant, or a creation form's format string. Any case. */
  variant?: string | null;
  /** Seats in the game. tournaments.max_players, or a form's field size. */
  maxPlayers?: number | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SINGLE SOURCE OF TRUTH FOR WHICH RATE A FORMAT PAYS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-27 audit: `SNG_RAKE_RATE = 0.05` was declared in
 * server/src/services/TournamentRecurringService.ts and had exactly ONE
 * consumer. The other five creation paths — the owner create modal, the legacy
 * tournament-page form, the table-config path, the client horse orchestrator
 * and the SCHEDULED tournament service — all called `splitBuyIn` at the 10%
 * default on a two-seat game.
 *
 * For four of those the damage was a lie rather than a loss: `fn_create_tournament`
 * is authoritative, knows the rule, and rewrites the split. The owner was
 * QUOTED "18 + 2 fee" on a 20-chip duel that was then written 19 + 1.
 *
 * ScheduledTournamentService was the money bug: it writes `buy_in_amount` and
 * `buy_in_fee` DIRECTLY, bypassing the RPC entirely, so a schedule row with
 * `type: 'sng'` produced a real 10% heads-up game.
 *
 * MTTs have unlimited entry fields. Only fixed formats can receive the
 * heads-up rate from their seat count.
 */
export function rakeRateFor(subject: RakeSubject): number {
  if (isUnlimitedMtt(subject)) return DEFAULT_RAKE_RATE;
  const type = String(subject?.tournamentType ?? '').toUpperCase();
  const variant = String(subject?.variant ?? '').toLowerCase();
  if (type === 'SPIN' || variant === 'spin') return SPIN_RAKE_RATE;

  const seats = Number(subject?.maxPlayers);
  // Unknown fixed-format capacity falls through to the default rate.
  if (Number.isFinite(seats) && seats > 0 && seats <= 2) return HEADS_UP_RAKE_RATE;

  return DEFAULT_RAKE_RATE;
}

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

/** Two decimal places, killing float noise. numeric(15,2) is what the
    columns are, so cents is the finest money this platform can store. */
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * THE FEE, IN CENTS (Dan 2026-08-25).
 *
 * "FRACTIONAL FEE'S NEED TO BE ALLOWED, WE HAVE 1 BUY IN, 5 BUY IN'S ETC THOSE
 * SHOULD BE .10 RAKE AND .50 RAKE PER BUY IN."
 *
 * The fee used to floor to a WHOLE chip, which is why a 1-chip game took
 * nothing and a 5-chip game took nothing: floor(1 x 0.1) and floor(5 x 0.1)
 * are both 0. The whole micro end of the ladder — 1, 2, 3, 5 — ran rake-free,
 * and the comment above this line called that a deliberate trade because "that
 * rule cannot coexist with a hard 10% cap WHILE FEES STAY WHOLE NUMBERS".
 *
 * They do not have to. buy_in_fee is numeric(15,2). Flooring to CENTS instead
 * of to chips honours the same ceiling exactly — 1 pays 0.10, 5 pays 0.50, 15
 * pays 1.50, and none of them is a fraction of a percent over 10 — while the
 * total the player pays stays the whole number it has always been (0.90 + 0.10
 * = 1.00), which is what every price display and the whole-total rule depend
 * on.
 *
 * Still a FLOOR, never a round: rounding a fee up is rounding the house's cut
 * up through its own ceiling, which is the exact bug fixed on 2026-08-21.
 */
function feeToCents(total: number, rakeRate: number): number {
  const exact = total * rakeRate;
  const floored = Math.floor(exact * 100 + 1e-9) / 100;
  return Math.min(total, Math.max(0, floored));
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
  /**
   * Dan 2026-08-21 (second batch): "RAKE IS EXCEEDING 10% ON THIS TOURNAMENT."
   * It was, and by a lot. Two earlier rules in this one line were fighting the
   * cap, and both of them won:
   *
   *   Math.round  — a 15 total gave round(1.5) = 2, i.e. 13.33%. Rounding a
   *                 fee UP is rounding the house's cut up past its own ceiling.
   *   Math.max(1) — added so small games could not enter rake-free. It made
   *                 them enter at ABSURD rake instead: a 5 total paid 1 (20%),
   *                 a 3 paid 1 (33%), a 1 paid 1 (100%). Live proof: every
   *                 Pre-Dawn Mystery Bounty today ran at 4 + 1 = 20%.
   *
   * 10% is a ceiling, not a target, so the fee FLOORS. It can never round up
   * through the cap, and no minimum is imposed:
   *
   *     10 -> 1 (10.0%)   15 -> 1 (6.7%)   20 -> 2 (10.0%)
   *     25 -> 2 (8.0%)   100 -> 10 (10.0%)
   *
   * The cost is that a total under 10 now takes NO rake, which reverses the
   * "every buy-in pays a fee" rule from earlier today. That rule cannot coexist
   * with a hard 10% cap while fees stay whole numbers — one chip on a 5 game is
   * 20% whatever else is true — and a cap the house exceeds is the more serious
   * of the two problems. Micro games are promotional; that is the trade.
   *
   * `assertRakeWithinCap` below is the guard that fails loudly if a third
   * writer ever reintroduces a rounding that breaches this.
   */
  const fee = feeToCents(t, rakeRate);
  // prize is computed by SUBTRACTION, never by its own rounding. Rounding both
  // ends independently is how prize + fee stops equalling total, and money that
  // does not reconcile on a money surface is a real bug later.
  return { total: t, prize: round2(t - fee), fee };
}

/** Snap first, then split. What every tournament generator should call. */
export function buyInFor(amount: number, rakeRate: number = DEFAULT_RAKE_RATE): BuyInSplit {
  return splitBuyIn(snapToWholeBuyIn(amount), rakeRate);
}

/**
 * THE CEILING (Dan 2026-08-21): the house never takes more than 10% of what a
 * player pays for a tournament seat.
 *
 * Exported as its own predicate rather than left implicit inside splitBuyIn
 * because splitBuyIn is not the only writer — owner-created tournaments come
 * through a form, and the recurring generator has its own configs. Anything
 * that writes `buy_in_amount` / `buy_in_fee` can check itself against this, and
 * the CHECK constraint added in
 * supabase/migrations/20260821_tournament_rake_cap.sql enforces it at the last
 * possible moment for writers nobody remembered to update.
 *
 * Freerolls (total 0) are trivially within cap.
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
  // 1e-9 absorbs float noise on exact-10% splits like 20 -> 2.
  return rakePctOf(prize, fee) <= rakeRate * 100 + 1e-9;
}

/**
 * Clamp any (prize, fee) pair onto the cap, preserving the total the player
 * pays. Use at a write boundary that has a fee it did not derive from
 * `splitBuyIn` — it keeps the advertised price identical and only moves the
 * split, so a player is never charged more than they were shown.
 */
export function clampRakeToCap(
  prize: number,
  fee: number,
  rakeRate: number = DEFAULT_RAKE_RATE
): { prize: number; fee: number } {
  const total = Math.max(0, Math.round(Number(prize || 0) + Number(fee || 0)));
  if (total === 0) return { prize: 0, fee: 0 };
  /* Cents, not whole chips (2026-08-25). This used to round the incoming fee to
     a whole number before capping it, which silently threw away every
     fractional fee it was handed — a 0.10 on a 1-chip game came back as 0. */
  const capped = Math.min(Math.max(0, round2(Number(fee || 0))), feeToCents(total, rakeRate));
  return { prize: round2(total - capped), fee: capped };
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

/**
 * Exact financial component display. Tournament prices remain whole chips,
 * but their prize/fee split is stored to cents (for example 13.50 + 1.50).
 * Never pass an on-felt stack through this helper: it exists for ledger parts.
 */
export function moneyExact(n: number): string {
  const v = Number(n);
  const exact = Number.isFinite(v) ? round2(v) : 0;
  return exact.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(exact) ? 0 : 2,
    maximumFractionDigits: 2,
  });
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
  // FREEROLLS ARE FREE BUY (Dan 2026-09-02): the cell says what the event
  // IS - free to enter, 1-chip rebuys and add-ons - not just "free".
  if (total <= 0) return FREE_BUY_LABEL;
  if (f <= 0) return money(total);
  // Entry totals stay whole chips; their disclosed components retain cents.
  // Derive the remainder from the displayed total so the split still adds up.
  const shownFee = Math.min(total, Math.max(0, round2(f)));
  return `${money(total)} (${moneyExact(total - shownFee)} + ${moneyExact(shownFee)})`;
}

/** Compact form for a narrow lobby card: just the total. */
export function formatBuyInShort(prize: number, fee: number | null | undefined): string {
  const total = totalBuyIn(Number(prize) || 0, fee);
  return total <= 0 ? FREE_BUY_LABEL : money(total);
}
