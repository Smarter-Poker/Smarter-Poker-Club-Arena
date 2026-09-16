import { isUnlimitedMtt, type TournamentEntryCapacitySubject } from '../tournament/tournamentEntryCapacity.js';
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
 * Dan 2026-08-25: "HEADS UP EVENTS ARE ONLY A 5% RAKE, SO A 1 CHIP BUY IN X 2
 * PLAYERS = 5% OF 2 CHIPS, SO WINNER TAKES ALL = 1.90 PAYOUT."
 */
export const HEADS_UP_RAKE_RATE = 0.05;

/**
 * A Spin charges the buy-in and NOTHING else — its rake is engineered into the
 * multiplier distribution (server/src/config/spinSpec.ts) and `buy_in_fee` must
 * be 0. The tournaments_spin_no_extra_rake constraint refuses a fee-bearing Spin.
 */
export const SPIN_RAKE_RATE = 0;

/** Mirror of RakeSubject in src/utils/buyIn.ts. */
export interface RakeSubject extends TournamentEntryCapacitySubject {
  /** tournaments.tournament_type — 'MTT' | 'SNG' | 'SPIN'. Any case. */
  tournamentType?: string | null;
  /** tournaments.variant, or a creation form's format string. Any case. */
  variant?: string | null;
  /** Seats in the game. tournaments.max_players, or a form's field size. */
  maxPlayers?: number | null;
}

/**
 * THE SINGLE SOURCE OF TRUTH FOR WHICH RATE A FORMAT PAYS. Full reasoning in
 * src/utils/buyIn.ts; the short version is that `SNG_RAKE_RATE` used to live in
 * TournamentRecurringService with one consumer while five other creation paths
 * quoted 10% on a two-seat game — and ScheduledTournamentService, which writes
 * the money columns directly rather than through fn_create_tournament, CHARGED
 * it.
 *
 * Keyed on SEATS, not on the word "SNG": a two-handed game is a duel whatever
 * its label says, and the label is the thing that varies between writers.
 *
 * MIRROR of src/utils/buyIn.ts — change one, change both.
 * tests/unit/tournamentRakeMirror.test.ts pins them together.
 */
export function rakeRateFor(subject: RakeSubject): number {
  if (isUnlimitedMtt(subject)) return DEFAULT_RAKE_RATE;
  const type = String(subject?.tournamentType ?? '').toUpperCase();
  const variant = String(subject?.variant ?? '').toLowerCase();
  if (type === 'SPIN' || variant === 'spin') return SPIN_RAKE_RATE;

  const seats = Number(subject?.maxPlayers);
  // `> 0` matters: 0 means "unlimited field" to some callers, and 0 is not a
  // heads-up game. An unknown seat count falls through to the DEFAULT rate,
  // never to the cheaper one.
  if (Number.isFinite(seats) && seats > 0 && seats <= 2) return HEADS_UP_RAKE_RATE;

  return DEFAULT_RAKE_RATE;
}

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
  const fee = feeToCents(t, rakeRate);
  // prize is computed by SUBTRACTION, never by its own rounding. Rounding both
  // ends independently is how prize + fee stops equalling total, and money that
  // does not reconcile on a money surface is a real bug later.
  return { total: t, prize: round2(t - fee), fee };
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
  /* MIRROR FIX 2026-08-26: the client copy (src/utils/buyIn.ts) moved to
     CENTS on 2026-08-25 with Dan's fractional-fee rule; this copy kept
     rounding the incoming fee to a whole chip and flooring the cap to whole
     chips, so every server-side pass through here silently stripped the 0.10
     fee off a 1-chip game — turning the micro end of the ladder rake-free
     again through the back door. Byte-for-byte the client's arithmetic now. */
  const capped = Math.min(Math.max(0, round2(Number(fee || 0))), feeToCents(total, rakeRate));
  return { prize: round2(total - capped), fee: capped };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FREEROLLS ARE FREE BUY (Dan, 2026-09-02, BINDING)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Dan, verbatim: "FREE ROLLS MUST ALWAYS BE SET AS 'FREE BUY'. ITS FREE TO
// ENTER, $0 BUY IN, BUT REBUYS AND ADD ON'S COST $1. MAKE SURE THAT IS BAKED IN
// HOW EVER ITS NEEDED."
//
// Every freeroll creator in this process spreads freeBuyColumns() over its
// insert row LAST, so the rule is passed explicitly rather than left to the
// database. The zz_freerolls_are_free_buy trigger (migration
// 20260902183602) is the backstop, not the mechanism: a row that reaches it
// already compliant leaves no ca_freeroll_free_buy_log entry, and a creator
// that keeps landing in that log is a creator that still needs this helper.
//
// The predicate mirrors fn_is_free_buy_event exactly: 0 to enter, 0 fee, an
// MTT-family event (not a Spin, whose price is its ladder; not an SNG, where a
// 0 prize side is a misconfigured duel rather than a freeroll).

/** What a rebuy costs in a freeroll. One chip, split by the rebuy RPC. */
export const FREE_BUY_REBUY_COST = 1;
/** What an add-on costs in a freeroll. One chip, split by the rebuy RPC. */
export const FREE_BUY_ADDON_COST = 1;
/** Levels the rebuy window stays open on a freeroll (tournaments.rebuy_levels default). */
export const FREE_BUY_REBUY_LEVELS = 4;
/** Levels the add-on window stays open after the rebuy cutoff (tournaments.addon_levels default). */
export const FREE_BUY_ADDON_LEVELS = 1;

export interface FreeBuySubject {
  /** Total the player pays to enter (prize + fee). 0 is a freeroll. */
  buyIn: number;
  /** 'MTT' | 'SNG' | 'SPIN' (case-insensitive). Defaults to MTT. */
  tournamentType?: string | null;
  /** tournaments.variant; 'spin' and 'sng' are never freerolls. */
  variant?: string | null;
}

/** Mirror of fn_is_free_buy_event: is this event a freeroll under the rule? */
export function isFreeBuyEvent(subject: FreeBuySubject): boolean {
  const total = Number(subject.buyIn);
  if (!Number.isFinite(total) || total !== 0) return false;
  const type = String(subject.tournamentType ?? 'MTT').toUpperCase();
  if (type !== 'MTT') return false;
  const variant = String(subject.variant ?? 'freezeout').toLowerCase();
  return variant !== 'spin' && variant !== 'sng';
}

export interface FreeBuyColumns {
  free_buy: boolean;
  addon_from_start: boolean;
  buy_in_fee: 0;
  is_rebuy: true;
  is_reentry: true;
  add_on_available: true;
  rebuy_cost: typeof FREE_BUY_REBUY_COST;
  addon_cost: typeof FREE_BUY_ADDON_COST;
  rebuy_chips: number;
  addon_chips: number;
  rebuy_levels: number;
  addon_levels: number;
  max_rebuys: number | null;
}

/**
 * The tournaments columns a freeroll MUST carry, or an empty object when the
 * event is not a freeroll. Spread it over the insert row after every other
 * rebuy/add-on key so it wins.
 *
 * `rebuy_chips` / `addon_chips` default to the starting stack (what a rebuy
 * buys back). `max_rebuys` is passed through when it is a positive count and
 * cleared otherwise: process_tournament_rebuy reads a NOT NULL 0 as
 * "Rebuy limit reached (0 of 0)", which would deny every freeroll rebuy.
 */
export function freeBuyColumns(
  subject: FreeBuySubject & {
    startingStack: number;
    rebuyChips?: number | null;
    addOnChips?: number | null;
    rebuyLevels?: number | null;
    addOnLevels?: number | null;
    maxRebuys?: number | null;
  }
): Partial<FreeBuyColumns> {
  /* Partial so a caller can spread it over an insert literal that already
     names these keys: TypeScript (TS2783) refuses a spread that would
     DEFINITELY overwrite an earlier key, and "definitely" is the point. */
  if (!isFreeBuyEvent(subject)) return {};
  const stack = wholeChips(subject.startingStack) || 10000;
  const chipsOr = (v: unknown) => wholeChips(v) || stack;
  const levelsOr = (v: unknown, dflt: number) => wholeChips(v) || dflt;
  const maxRebuys = wholeChips(subject.maxRebuys);
  return {
    free_buy: true,
    addon_from_start: true,
    buy_in_fee: 0,
    is_rebuy: true,
    is_reentry: true,
    add_on_available: true,
    rebuy_cost: FREE_BUY_REBUY_COST,
    addon_cost: FREE_BUY_ADDON_COST,
    rebuy_chips: chipsOr(subject.rebuyChips),
    addon_chips: chipsOr(subject.addOnChips),
    rebuy_levels: levelsOr(subject.rebuyLevels, FREE_BUY_REBUY_LEVELS),
    addon_levels: levelsOr(subject.addOnLevels, FREE_BUY_ADDON_LEVELS),
    max_rebuys: maxRebuys > 0 ? maxRebuys : null,
  };
}
