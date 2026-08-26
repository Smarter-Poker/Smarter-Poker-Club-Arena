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
export const CASH_MAX_BB = 100;

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

  const rowMin = positive(row.min_buy_in) || bandMin;
  const rowMax = positive(row.max_buy_in) || bandMax;

  /**
   * No blinds AND no columns means the row cannot say. Returning 0/0 printed
   * the literal "0" on the card and "0 Min / 0 Max" in the panel — a claim
   * about money that is not merely unknown but wrong. NaN was fixed here
   * earlier; zero is the same bug wearing a number.
   */
  if (bb <= 0) {
    if (rowMin <= 0 && rowMax <= 0) return { min: 0, max: 0, unknown: true };
    return { min: rowMin, max: Math.max(rowMin, rowMax) };
  }

  const min = Math.max(rowMin, bandMin);
  const max = Math.min(rowMax, bandMax);

  // Empty intersection: the row is configured outside the standard band, and
  // the row is what the database enforces.
  if (max < min) return { min: rowMin, max: Math.max(rowMin, rowMax) };

  return { min, max };
}

/** "1,000 - 2,500", or a single figure when the range has collapsed. */
export function cashBuyInLabel(row: CashBuyInSource): string {
  const { min, max, unknown } = cashBuyInRange(row);
  /* A dash, not a zero. "0" is a statement that the table is free. */
  if (unknown) return '-';
  if (max <= min) return min.toLocaleString();
  return `${min.toLocaleString()} - ${max.toLocaleString()}`;
}
