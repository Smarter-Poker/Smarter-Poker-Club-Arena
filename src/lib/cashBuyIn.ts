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
 * VIP_ONLY, NIT_GAME, TABLE_SIZE, NO_RATHOLE, TABLE_CAP_REACHED. Nothing ever
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
export function cashBuyInRefusalText(raw: unknown): string | null {
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
  if (/NO_RATHOLE/.test(m)) {
    const amt = m.match(/return with the ([\d,.]+)/);
    return amt
      ? `This Table Requires You To Return With The ${amt[1]} You Left With`
      : 'This Table Requires You To Return With The Stack You Left With';
  }
  if (/VIP_ONLY/.test(m)) return 'This Table Is Open To VIP Members Only';
  if (/IS_TEMPLATE/.test(m)) return 'This Is A Saved Table Template, Not A Live Game';
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
  /* Both wallet shortfalls. The player's own balance is the ONLY case where
     "check your balance" was ever the right advice, so it is the only case
     that still says it. */
  if (/Insufficient club chips/i.test(m)) return 'The Club Treasury Cannot Cover This Buy In';
  if (/No club wallet resolves/i.test(m)) return 'No Club Wallet Was Found For You At This Table';
  return null;
}
