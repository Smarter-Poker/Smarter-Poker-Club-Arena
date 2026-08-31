/**
 * Bankroll telemetry — why the ladder did what it did.
 *
 * WHY THIS EXISTS. The bankroll layer refuses seats, caps buy-ins, declines
 * reloads and stands horses up, and every one of those decisions was silent.
 * After the 10,000-chip reset the first question anyone will ask is "is the
 * ladder actually working, or is it just quietly emptying the floor?" — and
 * with no counters the only available answer is a shrug and a guess.
 *
 * A refusal and an outage look identical from the outside: no horses sat. The
 * difference is entirely in the reason, so the reason is what gets recorded.
 *
 * Deliberately in-memory and free. This is a hot path — the seeding cycle runs
 * every 30 seconds over the whole fleet — so a counter must cost a map lookup
 * and nothing else. It is diagnostic, not accounting: chip movement is already
 * durably recorded in `chip_ledger` and `chip_transactions`, and NOTHING here
 * is a substitute for those.
 */

export type BankrollEvent =
  /** Refused a cash seat: the roll does not cover the stake. */
  | 'seat_refused_underrolled'
  /** Refused a cash seat: no club membership row, so no roll to read. */
  | 'seat_refused_no_membership'
  /** Refused a cash seat: the policy share cannot reach the table minimum. */
  | 'seat_refused_share_below_min'
  /** Refused an ADDITIONAL table: aggregate exposure ceiling. */
  | 'seat_refused_aggregate_exposure'
  /** Seated, with the buy-in capped below the profiled amount by the policy. */
  | 'buyin_capped'
  /** Declined a reload. */
  | 'topup_refused'
  /** Left the table up its stop-win. */
  | 'session_book_win'
  /** Left the table down its stop-loss. */
  | 'session_stop_loss'
  /** Declined to rebuy after busting: the roll no longer carries this stake. */
  | 'rebuy_refused_underrolled'
  /** Declined to rebuy after busting: at the temperament's stop-loss. */
  | 'rebuy_refused_stop_loss'
  /** Refused a tournament entry: the roll does not cover the event. */
  | 'tournament_refused_underrolled'
  /** Entered a freeroll while unable to afford any paid game. */
  | 'freeroll_entered_broke'
  /** Could not afford ANY open cash game — the move-down ladder ran out. */
  | 'ladder_exhausted'
  /** Dropped a stake band because the roll no longer carried the old one. */
  | 'moved_down_a_stake'
  /** Climbed back toward the earned band after clearing the stricter bar. */
  | 'moved_up_a_stake';

/**
 * COUNTERS ACCUMULATE; GAUGES DO NOT.
 *
 * `ladder_exhausted` answers "how many horses are stranded RIGHT NOW", and a
 * running total of a standing condition is a number that only goes up: 40
 * stranded horses re-counted every 30 seconds reads as 115,200 a day and means
 * nothing. It is recorded as a gauge — last value wins — while every genuine
 * event beside it keeps counting.
 */
const GAUGES: ReadonlySet<BankrollEvent> = new Set<BankrollEvent>(['ladder_exhausted']);

const counters = new Map<BankrollEvent, number>();

export function bankrollEvent(e: BankrollEvent, n = 1): void {
  counters.set(e, GAUGES.has(e) ? n : (counters.get(e) ?? 0) + n);
}

export function bankrollCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetBankrollCounters(): void {
  counters.clear();
}

/**
 * One line, only when something happened.
 *
 * A zero-suppressed summary, because a log line that prints twelve zeroes
 * every cycle is a line nobody reads, and the whole value of this module is
 * that somebody reads it.
 */
export function bankrollSummaryLine(): string | null {
  const parts = [...counters.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`);
  return parts.length > 0 ? `[Bankroll] ${parts.join(' ')}` : null;
}
