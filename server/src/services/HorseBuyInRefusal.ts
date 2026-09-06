/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A REFUSED BUY-IN SAYS WHY (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `seatHorse` returns false and, for seven expected refusals, reports nothing
 * at all - deliberately, because a seeding race is not an incident. The cost
 * of that silence was measured on 2026-09-06: opening feeders selected 156
 * horses in three hours and seated 34, and the engine log carried ONE line
 * per feeder saying "selected 4, seated 0" with an empty skip map. Nothing
 * anywhere said which door had shut. The answer turned out to be FOUR TABLE
 * LIMIT - 10,577 of them in under four hours - and it took the Postgres error
 * log to find it, two days after the feeder loop was first investigated.
 *
 * A refusal is still not an incident. It is now a COUNTER: this maps the
 * database's message to a short token, the seeding loop folds it into the
 * opening-feeder diagnostic and into one cycle line, and the next agent can
 * read the shape of the floor's refusals without a database.
 */

export type BuyInRefusal =
  | 'four_game_limit'
  | 'table_cap'
  | 'no_chips'
  | 'already_seated'
  | 'seat_taken'
  | 'seat_reserved'
  | 'below_floor'
  | 'table_closing'
  | 'table_full'
  | 'vpip_barred'
  | 'nit_game'
  | 'no_wallet'
  | 'frozen'
  | 'refused';

/**
 * The token for a refusal message. Ordered so the specific literals are tried
 * before the general ones; an unrecognised message is `refused`, never a
 * silence.
 */
export function classifyBuyInRefusal(message: string | null | undefined): BuyInRefusal {
  const m = String(message ?? '');
  if (m.includes('FOUR TABLE LIMIT')) return 'four_game_limit';
  if (m.includes('TABLE_CAP_REACHED')) return 'table_cap';
  if (m.includes('Insufficient club chips') || m.includes('Insufficient balance'))
    return 'no_chips';
  if (m.includes('Player already seated')) return 'already_seated';
  if (m.includes('duplicate key')) return 'seat_taken';
  if (m.includes('SEAT_RESERVED')) return 'seat_reserved';
  if (m.includes('BUYIN_BELOW_FLOOR')) return 'below_floor';
  if (m.includes('TABLE_CLOSING')) return 'table_closing';
  if (m.includes('TABLE_SIZE')) return 'table_full';
  if (m.includes('VPIP_BARRED')) return 'vpip_barred';
  if (m.includes('NIT_GAME')) return 'nit_game';
  if (m.includes('No club wallet resolves')) return 'no_wallet';
  return 'refused';
}

/** `reason=count reason=count`, non-zero only, in first-seen order. */
export function formatRefusals(counts: ReadonlyMap<string, number>): string {
  return [...counts]
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${r}=${n}`)
    .join(' ');
}
