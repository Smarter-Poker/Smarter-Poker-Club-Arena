/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT SEAT STACK IS A WHOLE CHIP (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The two places a tournament stack is stored do not have the same shape:
 *
 *     table_seats.stack        numeric(15,2)   keeps 1234.50
 *     tournament_players.chips integer         stores 1235
 *
 * The authoritative hand commit writes BOTH from one target and then asserts
 * they agree. A fractional target cannot satisfy that assertion, because the
 * integer column rounds it on assignment - so the whole hand is rolled back
 * with `tournament % hand % did not durably sync every final seat stack`
 * (supabase/migrations/20260910054712_a_hand_settles_each_seat_once.sql:649),
 * and ServerTableEngineSettlement then kills the engine generation. Nothing
 * is paid twice and no chip moves; what is lost is the hand.
 *
 * Measured: drift incident 07ebac1d-d829-401f-8008-d67dc2eb833b - 56 refused
 * hands across 15 tournament tables between 00:00 and 01:37 UTC on
 * 2026-09-11, every one of them this. Three days earlier the SAME defect was
 * refused under a different sentence - `accepted tournament hand produced
 * fractional stack 691173.50 for ...` - by the guard the 2026-09-10 rewrite
 * replaced, 500 more alerts on 2026-09-08/09.
 *
 * The inlet that produced the fraction was the auto-escalated blind level
 * (`ratio^k` is fractional at every ratio but 2), closed at source by
 * `escalatedBlindLevel` in server/src/tournament/blindEscalation.ts. THIS is
 * the other half: the invariant itself, checked where the payload is built,
 * so the NEXT inlet is named by the engine - seat, value and fraction - and
 * not discovered as a generic sentence from the database after the hand has
 * already been destroyed.
 *
 * It is a DETECTOR, deliberately, and the docblock says so because the
 * temptation to "just round it" is the whole point. A tournament hand is held
 * to exact conservation (tournamentChipConservation.ts): rounding a seat here
 * mints or destroys the fraction and the very next assertion refuses the hand
 * for conservation instead. A fraction cannot be repaired at settlement. It
 * must not be created.
 *
 * Pure. The caller decides what to do with a verdict.
 */

export interface WholeChipStack {
  user_id: string;
  /** The stack the engine intends to commit. */
  stack: number;
  /** The stack the seat was dealt from, when the caller has it. */
  stack_before?: number;
}

export interface FractionalSeat {
  user_id: string;
  /** Which of the two values carried the fraction. */
  field: 'stack' | 'stack_before';
  value: number;
  /** value - trunc(value), rounded to a cent. Signed, like the value. */
  fraction: number;
}

export interface WholeChipVerdict {
  ok: boolean;
  /** Every offending (seat, field) pair, in payload order. */
  offenders: FractionalSeat[];
  /** Sum of the `stack` fractions, to a cent. Zero when they cancel out. */
  fractionTotal: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A value the integer column can store without changing it.
 *
 * Non-finite is NOT whole: NaN and Infinity reach the commit as a malformed
 * payload, and calling them "whole" would hide them behind the one check that
 * is looking at exactly this field.
 */
const isWholeChip = (n: number): boolean => Number.isFinite(n) && round2(n) === Math.trunc(n);

export function checkTournamentWholeChips(stacks: readonly WholeChipStack[]): WholeChipVerdict {
  const offenders: FractionalSeat[] = [];
  let fractionTotal = 0;

  for (const seat of stacks) {
    const stack = Number(seat.stack);
    if (!isWholeChip(stack)) {
      offenders.push({
        user_id: seat.user_id,
        field: 'stack',
        value: stack,
        fraction: Number.isFinite(stack) ? round2(stack - Math.trunc(stack)) : stack,
      });
      if (Number.isFinite(stack)) fractionTotal += stack - Math.trunc(stack);
    }
    if (seat.stack_before !== undefined) {
      const before = Number(seat.stack_before);
      if (!isWholeChip(before)) {
        offenders.push({
          user_id: seat.user_id,
          field: 'stack_before',
          value: before,
          fraction: Number.isFinite(before) ? round2(before - Math.trunc(before)) : before,
        });
      }
    }
  }

  return { ok: offenders.length === 0, offenders, fractionTotal: round2(fractionTotal) };
}

/** One line per offending seat, for an alert a person has to act on. */
export function describeFractionalSeats(offenders: readonly FractionalSeat[]): string {
  return offenders.map((o) => `${o.user_id} ${o.field}=${o.value}`).join(', ');
}
