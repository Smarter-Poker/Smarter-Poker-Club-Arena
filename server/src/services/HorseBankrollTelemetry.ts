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
  /** Refused a cash seat: the policy share cannot reach the table minimum. */
  | 'seat_refused_share_below_min'
  /** Refused an ADDITIONAL table: the aggregate exposure ceiling. */
  | 'seat_refused_aggregate_exposure'
  /**
   * Seated WITHOUT a bankroll opinion, because no membership row for that
   * club could be read. Not a refusal - the gate fails open by design, and
   * the line that made this a refusal instead emptied the cash floor for
   * forty minutes on 2026-08-31. It is counted because a gate that silently
   * abstains for half the fleet is a gate nobody can trust: 261 of 584
   * horses are not members of the club that owns every open cash table, and
   * until this counter existed that number was only visible by hand.
   */
  | 'seat_fail_open_roll_unknown'
  /** Seated, with the buy-in capped below the profiled amount by the policy. */
  | 'buyin_capped'
  /** Declined a reload that would otherwise have been paid. */
  | 'topup_refused'
  /** Left the table up its stop-win. */
  | 'session_book_win'
  /** Left the table down its stop-loss. */
  | 'session_stop_loss'
  /** Refused a tournament entry: the roll does not cover the event. */
  | 'tournament_refused_underrolled'
  /** Entered a freeroll while unable to afford any paid game. */
  | 'freeroll_entered_broke'
  /** Declined to rebuy after busting: the roll no longer carries this stake. */
  | 'rebuy_refused_underrolled'
  /** Declined to rebuy after busting: at the temperament's stop-loss. */
  | 'rebuy_refused_stop_loss'
  /** Could not afford ANY open cash game - the move-down ladder ran out. */
  | 'ladder_exhausted';

/**
 * COUNTERS ACCUMULATE; GAUGES DO NOT.
 *
 * `ladder_exhausted` answers "how many horses are stranded RIGHT NOW", and a
 * running total of a standing condition is a number that only goes up: 40
 * stranded horses re-counted every 30 seconds reads as 115,200 a day and means
 * nothing. It is recorded as a gauge - last value wins - while every genuine
 * event beside it keeps counting.
 */
const GAUGES: ReadonlySet<BankrollEvent> = new Set<BankrollEvent>(['ladder_exhausted']);

const counters = new Map<BankrollEvent, number>();

/** What `bankrollSummaryLine` last reported, so the next line can report the change. */
const lastReported = new Map<BankrollEvent, number>();

export function bankrollEvent(e: BankrollEvent, n = 1): void {
  counters.set(e, GAUGES.has(e) ? n : (counters.get(e) ?? 0) + n);
}

export function bankrollCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetBankrollCounters(): void {
  counters.clear();
  lastReported.clear();
}

/**
 * One line, only when something happened THIS cycle.
 *
 * Zero-suppressed, because a line that prints twelve zeroes every cycle is a
 * line nobody reads, and the whole value of this module is that somebody
 * reads it.
 *
 * And reported as a DELTA, not as the running total. The seeding cycle prints
 * this every 30 seconds against counters that only ever climb, so a total
 * answers "has this ever happened" - a question that is permanently yes after
 * the first occurrence and therefore worthless at 3am. The delta answers "is
 * this happening now", which is the question the cash floor going quiet
 * actually poses. Gauges are exempt: `ladder_exhausted` is already a
 * right-now number, so it prints its value, and it prints even when unchanged
 * so a standing strand never falls silent.
 */
export function bankrollSummaryLine(): string | null {
  const parts: Array<[string, number]> = [];
  for (const [event, total] of counters) {
    if (GAUGES.has(event)) {
      lastReported.set(event, total);
      if (total > 0) parts.push([event, total]);
      continue;
    }
    const delta = total - (lastReported.get(event) ?? 0);
    lastReported.set(event, total);
    if (delta > 0) parts.push([event, delta]);
  }
  if (parts.length === 0) return null;
  parts.sort((a, b) => b[1] - a[1]);
  return `[Bankroll] ${parts.map(([k, n]) => `${k}=${n}`).join(' ')}`;
}
