/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CASH BUY-IN — the range a player can ACTUALLY bring to the table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "the min and max buy in's are wrong, almost all of them say
 * you can buy in for more then whats actually allowed at the table."
 *
 * He is right, and the reason is that four layers disagreed about one number:
 *
 *   - `atomic_table_buyin` (the RPC, the only HARD enforcement) rejects
 *     anything outside `tables.min_buy_in` … `tables.max_buy_in`.
 *   - the table's BuyInModal never reads those columns at all — it offers a
 *     slider from `bb * 40` to `bb * 100` and nothing else.
 *   - every writer of the columns (TableService, HorseFleetManager,
 *     HorseOrchestrator) stamps `bb * 40` … `bb * 200`.
 *   - the lobby printed the columns raw, so it advertised a 200bb ceiling that
 *     the only buy-in UI in the product will not sell. Measured on production:
 *     42 of 46 live cash tables carried `max_buy_in > bb * 100`.
 *
 * So the lobby was not lying about the DATA; it was lying about the OFFER. What
 * a player can actually put on the table is the INTERSECTION of the two: the
 * modal's band, clamped by the row the RPC enforces. That is what this returns,
 * and the lobby, the game-lobby panel and every future surface read it from
 * here so they cannot drift apart again.
 *
 * The one exception is an incoherent row — `NLH 25/50 INSURANCE TEST` carries
 * min 100 / max 200 on a 50 big blind, so its ceiling sits BELOW the standard
 * floor and the intersection is empty. There the row itself wins: it is what
 * the RPC will enforce, and printing the band instead would advertise a
 * buy-in that is guaranteed to be rejected.
 */

/** The standard band the table's BuyInModal offers, in big blinds. */
export const CASH_MIN_BB = 40;
export const CASH_MAX_BB = 200;

export interface CashBuyInSource {
  big_blind?: number | null;
  min_buy_in?: number | null;
  max_buy_in?: number | null;
}

export interface CashBuyInRange {
  min: number;
  max: number;
  /** The row carries no blinds and no buy-in columns: nothing can be said. */
  unknown?: boolean;
}

const positive = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function cashBuyInRange(row: CashBuyInSource): CashBuyInRange {
  const bb = positive(row.big_blind);
  const bandMin = bb * CASH_MIN_BB;
  const bandMax = bb * CASH_MAX_BB;

  const rowMin = positive(row.min_buy_in);
  const rowMax = positive(row.max_buy_in);

  if (bb <= 0) {
    if (!rowMin && !rowMax) return { min: 0, max: 0, unknown: true };
    return { min: rowMin || 0, max: Math.max(rowMin || 0, rowMax || 0) };
  }

  const min = rowMin > 0 ? rowMin : bandMin;
  const max = rowMax > 0 ? rowMax : bandMax;

  return { min, max: Math.max(min, max) };
}

/** "1,000 - 2,500", or a single figure when the range has collapsed. */
export function cashBuyInLabel(row: CashBuyInSource): string {
  const { min, max, unknown } = cashBuyInRange(row);
  /* A dash, not a zero. "0" is a statement that the table is free. */
  if (unknown) return '-';
  if (max <= min) return min.toLocaleString();
  return `${min.toLocaleString()} - ${max.toLocaleString()}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CASH BUY-IN REFUSALS — say which rule stopped you
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-28. `atomic_table_buyin` refuses a seat for SIXTEEN distinct reasons,
 * and six of them are already tagged for a machine to read: IS_TEMPLATE,
 * VIP_ONLY, NIT_GAME, TABLE_SIZE, BUYIN_BELOW_FLOOR, TABLE_CAP_REACHED. Nothing ever
 * read them. Every one of those refusals — banned from the club, VIP-only
 * table, career VPIP below the table's floor, table full, buy-in under the
 * minimum or over the maximum, club treasury short — arrived at the player as
 * one sentence:
 *
 *     "Buy-in failed. Please try again or check your balance."
 *
 * Which is wrong in the specific way that wastes somebody's evening: it names
 * the one thing that is NOT the problem, and sends them to the cashier to look
 * for it. A player refused for a 200-chip minimum tops up, tries again, and is
 * refused identically.
 *
 * This maps a refusal to the rule that actually fired. It returns null for
 * anything it does not recognise, so an unknown refusal keeps the generic text
 * AND still reaches error reporting rather than being quietly relabelled.
 *
 * The messages carry the server's own numbers wherever the server sent them —
 * a minimum a player cannot see is a minimum they cannot meet.
 */
/** Only these two seat indexes can prove a seat collision after receipt claim.
 * Other unique violations, especially receipt conflicts, remain unresolved.
 */
export function cashBuyInSeatConflictText(raw: unknown): string | null {
  const error = raw as { code?: unknown; message?: unknown } | null;
  if (error?.code !== '23505' || typeof error.message !== 'string') return null;
  const constraint = error.message.match(
    /^duplicate key value violates unique constraint "(table_seats_table_id_seat_number_key|idx_unique_active_user_per_table)"$/
  )?.[1];
  if (constraint === 'table_seats_table_id_seat_number_key')
    return 'That Seat Was Taken. Please Choose Another Seat.';
  if (constraint === 'idx_unique_active_user_per_table')
    return 'You Are Already Seated At This Table';
  return null;
}

export function cashBuyInRefusalText(raw: unknown): string | null {
  const seatConflict = cashBuyInSeatConflictText(raw);
  if (seatConflict) return seatConflict;
  const m = String((raw as { message?: string })?.message ?? raw ?? '');
  if (!m) return null;

  /* The four-table cap, raised by fn_enforce_four_table_limit /
     fn_enforce_booking_game_cap as a 23514 that used to escape untranslated. */
  if (/FOUR TABLE LIMIT|table_limit_reached/.test(m)) {
    return 'You Are Already In Four Games, Leave One To Join Another';
  }
  if (/TABLE_CAP_REACHED/.test(m)) {
    const seated = m.match(/already seated at (\d+) cash tables \(max (\d+)\)/);
    return seated
      ? `You Are Already At ${seated[1]} Cash Tables, The Limit Is ${seated[2]}`
      : 'You Are Already At The Maximum Number Of Cash Tables';
  }
  if (/NIT_GAME/.test(m)) {
    const vpip = m.match(/at least ([\d.]+)/);
    return vpip
      ? `This Table Requires A Career VPIP Of At Least ${vpip[1]} Percent`
      : 'This Table Has A Minimum Career VPIP You Do Not Meet Yet';
  }
  /* CHIP CONTINUITY: the rejoin floor. The number is the whole message
     (OPORD 1.3 section 6.1: the minimum is just higher, no paragraph why). */
  if (/BUYIN_BELOW_FLOOR/.test(m)) {
    const amt = m.match(/right now is ([\d,.]+)/);
    return amt
      ? `The Minimum Buy In For This Game Right Now Is ${amt[1]}`
      : 'The Minimum Buy In For This Game Is Higher Right Now';
  }
  /* Booted for low VPIP: no seat in this game until the bar lifts (Dan
     2026-09-05). The number is seconds, printed as minutes. */
  if (/VPIP_BARRED|GAME_BARRED/.test(m)) {
    const secs = m.match(/BARRED:(\d+)/);
    const mins = secs ? Math.max(1, Math.ceil(Number(secs[1]) / 60)) : null;
    return mins
      ? `You Were Removed For Low VPIP. You May Rejoin This Game In ${mins} ${mins === 1 ? 'Minute' : 'Minutes'}`
      : 'You Were Removed For Low VPIP And Cannot Rejoin This Game Yet';
  }
  if (/BUYIN_ABOVE_MAX/.test(m)) {
    const max = m.match(/maximum \(([\d,.]+)\)/);
    return max
      ? `Your Stack Cannot Go Above The Table Maximum Of ${max[1]}`
      : 'Your Stack Cannot Go Above The Table Maximum';
  }
  /* ─── THE DIAMOND REFUSALS (2026-09-12) ──────────────────────────────────
     Every one of these reached the player as the caller's generic fallback,
     which is "Buy-in failed. Please check your balance and try again." Three
     of them have nothing to do with a balance, and one of them is a table that
     is not open yet - so the arena told a waitlisted player who arrived on
     time that they were short of Diamonds.

     The refusal names are the SQL exception names raised by
     `fn_poker_diamond_buyin` and the custody functions under it. They are
     matched on the name rather than on prose, because the prose is a sentence
     written for a log and these are sentences written for a player. */
  if (/insufficient_settled_diamonds/.test(m))
    return 'Your Settled Diamonds Do Not Cover This Buy In. Diamonds Settle Before They Can Be Staked.';
  if (/diamond_cash_not_open/.test(m)) return 'Diamond Cash Games Are Not Open Yet';
  if (/diamond_plain_cash_table_required|diamond_cash_table_required/.test(m))
    return 'This Table Is Not Set Up For Diamond Play';
  if (
    /diamond_cash_requires_whole_amounts|invalid_diamond_cash_purchase|invalid_diamond_table_buy_in/.test(
      m
    )
  )
    return 'A Diamond Buy In Must Be A Whole Number Of Diamonds';
  if (/diamond_debt_requires_settlement/.test(m))
    return 'Settle Your Outstanding Diamonds Before Taking A Seat';
  if (/diamond_custody_requires_settlement/.test(m))
    return 'Your Last Seat Has Not Finished Settling Yet. Try Again In A Moment.';
  if (/diamond_purchase_arena_mismatch/.test(m))
    return 'That Purchase Belongs To A Different Arena';
  if (/diamond_seat_custody_binding_failed|diamond_target_closed/.test(m))
    return 'That Seat Could Not Be Held. Try Again.';
  if (/diamond_arena_policy_missing/.test(m)) return 'The Arena Is Not Accepting Seats Right Now';
  /* The top-up door, which the cashier reaches through the same translator. */
  if (/diamond_top_up_exceeds_max_buy_in/.test(m))
    return 'That Would Put You Over This Table Maximum';
  if (/diamond_top_up_requires_a_live_seat/.test(m)) return 'You Are Not Seated At This Table';
  if (/diamond_top_up_stale_seat|diamond_top_up_custody_mismatch/.test(m))
    return 'The Seat Changed While That Was In Flight. Try Again.';

  if (/VIP_ONLY/.test(m)) return 'This Table Is Open To VIP Members Only';
  if (/IS_TEMPLATE/.test(m)) return 'This Is A Saved Table Template, Not A Live Game';
  if (/^SEAT_RESERVED:/.test(m))
    return 'This Seat Is Reserved For The Next Player On The Waiting List. Please Join The Waitlist.';
  if (/TABLE_SIZE: table is full/.test(m)) return 'This Table Is Full';
  if (/TABLE_SIZE: seat/.test(m)) return 'That Seat Does Not Exist At This Table';
  if (/Player already seated at this table/i.test(m)) {
    return 'You Are Already Seated At This Table';
  }
  if (/Banned from this club/i.test(m)) return 'You Cannot Buy In At This Club';
  if (/Buy-in below table minimum/i.test(m)) {
    const min = m.match(/min ([\d,.]+)/);
    return min
      ? `The Minimum Buy In At This Table Is ${min[1]}`
      : 'Your Buy In Is Below This Table Minimum';
  }
  if (/Buy-in above table maximum/i.test(m)) {
    const max = m.match(/max ([\d,.]+)/);
    return max
      ? `The Maximum Buy In At This Table Is ${max[1]}`
      : 'Your Buy In Is Above This Table Maximum';
  }
  if (/Invalid buy-in amount/i.test(m)) return 'That Buy In Amount Is Not Valid';
  // The server raises this after the conditional club_members wallet debit.
  // It is the player's club wallet, not the club treasury.
  if (/Insufficient club chips/i.test(m))
    return 'Your Club Wallet Does Not Have Enough Chips For This Buy In';
  if (/No club wallet resolves/i.test(m)) return 'No Club Wallet Was Found For You At This Table';
  return null;
}
