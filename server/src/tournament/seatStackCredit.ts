/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SEAT CREDIT FUNDS A RESERVATION. IT NEVER TOUCHES A GAME IN PROGRESS.
 *  (chip-std Lane F, 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `creditSeatStacks` exists for one reason: a Spin seats its players before
 * the wheel turns, at zero chips, and writes the drawn stack onto every seat
 * after the reveal. It is also called from `resume()` after every engine
 * restart, so a restart inside the reveal window still funds the field.
 *
 * Everything else it has ever done was a chip mint. Measured on production
 * 2026-08-31 / 09-01 (`docs/changelog/2026-09-02-chip-std-spin-chips.md`):
 * 23 of 23 sampled spin/SNG games with a broken chip total broke it BETWEEN
 * two hands, across an engine restart, by exactly this function raising
 * seats to `starting_chips`. Two shapes survived PR #2333:
 *
 *   1. a seat at 0 during play is a BUSTED player whose elimination the
 *      restart interrupted, not a stranded reservation - and it was revived
 *      with a fresh stack (`0573b719`: hand 3976291 ends 0/1527/1473, hand
 *      3976383 starts 1000/1497/1503);
 *   2. "play under way" was read from `hand_history`, so a game whose hand
 *      rows had not landed before the restart looked pre-deal and every
 *      losing seat was topped up (`3a2fee36`: a seat holding 620 on a
 *      300-chip board, and both short seats raised to 300).
 *
 * This module is the decision, kept pure so the production games above are
 * its fixtures. The rules:
 *
 *   - Play is under way if any hand was ever recorded for the tournament OR
 *     any live seat holds MORE than the starting stack. Chips are conserved,
 *     so a seat above the target is proof that chips have moved between
 *     seats; that signature does not depend on a history row surviving a
 *     restart.
 *   - Once play is under way, nothing is funded. Not a short seat, not a
 *     zero seat. A zero seat is a bust for the elimination sweep to finish.
 *   - Before play, seats below the target are raised to it - the stranded
 *     reservation the resume path exists for - but only while the felt total
 *     plus the credit stays within the tournament's chip supply. A credit
 *     that would put more chips on the felt than were ever issued is refused
 *     outright and named, because it cannot be a reservation.
 *
 * Horses and humans are identical here: the rule reads stacks, never who
 * holds them (CLAUDE.md 10.5).
 */

export interface CreditableSeat {
  id: string;
  stack: number;
}

export interface SeatFundingInput {
  seats: CreditableSeat[];
  /** The stack every seat is owed before the first deal (`starting_chips`). */
  target: number;
  /** A hand_history row exists for this tournament (or the read failed). */
  handRecorded: boolean;
  /**
   * Every chip the tournament has issued: entrants x starting stack plus
   * rebuy / re-entry / add-on grants. `null` when unknown (read failed) -
   * then no ceiling is applied and the caller is told so.
   */
  chipSupply: number | null;
}

export interface SeatFundingDecision {
  /** Seat ids to raise to `target`. Empty when nothing may be funded. */
  fund: string[];
  /** Chips the credit would add to the felt. */
  credit: number;
  playUnderWay: boolean;
  /** Set when a pre-deal credit was refused because it would exceed supply. */
  refused: { reason: 'exceeds_supply'; feltTotal: number; chipSupply: number } | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function selectSeatsToFund(input: SeatFundingInput): SeatFundingDecision {
  const target = num(input.target);
  const seats = input.seats ?? [];
  const feltTotal = seats.reduce((sum, s) => sum + num(s.stack), 0);
  const anySeatAboveTarget = seats.some((s) => num(s.stack) > target);
  const playUnderWay = input.handRecorded || anySeatAboveTarget;

  if (target <= 0 || playUnderWay) {
    return { fund: [], credit: 0, playUnderWay, refused: null };
  }

  const short = seats.filter((s) => num(s.stack) < target);
  const credit = short.reduce((sum, s) => sum + (target - num(s.stack)), 0);
  if (credit <= 0) {
    return { fund: [], credit: 0, playUnderWay, refused: null };
  }

  if (input.chipSupply !== null && feltTotal + credit > num(input.chipSupply)) {
    return {
      fund: [],
      credit: 0,
      playUnderWay,
      refused: { reason: 'exceeds_supply', feltTotal, chipSupply: num(input.chipSupply) },
    };
  }

  return { fund: short.map((s) => s.id), credit, playUnderWay, refused: null };
}

/**
 * The chip supply of a tournament, from its roster: every entrant was issued
 * the starting stack, and each rebuy / re-entry / add-on issued the grant
 * `process_tournament_rebuy` uses (`rebuy_chips` / `addon_chips`, each
 * defaulting to `starting_chips`). Early-bird bonuses ride on the player row
 * and are passed in as `bonusChips`.
 */
export function tournamentChipSupply(args: {
  entrants: number;
  startingChips: number;
  rebuyCount: number;
  addonCount: number;
  rebuyChips?: number | null;
  addonChips?: number | null;
  bonusChips?: number;
}): number {
  const start = num(args.startingChips);
  const rebuyGrant = num(args.rebuyChips) > 0 ? num(args.rebuyChips) : start;
  const addonGrant = num(args.addonChips) > 0 ? num(args.addonChips) : start;
  return (
    num(args.entrants) * start +
    num(args.rebuyCount) * rebuyGrant +
    num(args.addonCount) * addonGrant +
    num(args.bonusChips)
  );
}
