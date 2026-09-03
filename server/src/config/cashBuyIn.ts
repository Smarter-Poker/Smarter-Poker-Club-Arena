/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASH BUY-IN FLOOR (server mirror of src/lib/cashBuyIn.ts)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "IN A CASH GAME, CHECK IF THEY HAVE ENOUGH CHIPS TO REBUY,
 * (40 BB MINIMUM). IF THEY DO, YOU GIVE THEM THE 5 SECOND PERIOD TO REBUY OR
 * DECLINE."
 *
 * The engine has to answer "can this busted player actually buy back in?"
 * before it decides whether to hold the felt for them. That question is
 * `wallet >= the table's minimum buy-in`, and the minimum buy-in already has a
 * single canonical definition in src/lib/cashBuyIn.ts: the row's own
 * `min_buy_in` when it carries one, otherwise 40 big blinds.
 *
 * WHY A COPY: server/tsconfig.json sets `rootDir: ./src`, so nothing under
 * server/ can import from the app's src/. This is the same arrangement
 * server/src/config/buyIn.ts has with src/utils/buyIn.ts, for the same reason.
 * CHANGE ONE, CHANGE BOTH — tests/unit/cashBuyInMirror.test.ts pins the two
 * files together and fails if the constants drift.
 *
 * Deliberately NOT a re-derivation. src/lib/cashBuyIn.ts exists precisely
 * because four layers had each invented their own answer to this number and
 * the lobby ended up advertising a buy-in the RPC would refuse. A fifth answer
 * living in the engine would be that bug again, and this time it would decide
 * whether somebody keeps their seat.
 */

/** The standard band the table's BuyInModal offers, in big blinds. */
export const CASH_MIN_BB = 40;
export const CASH_MAX_BB = 200;

export interface CashBuyInSource {
  big_blind?: number | null;
  min_buy_in?: number | null;
  max_buy_in?: number | null;
}

const positive = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * The smallest stack this table will actually sell, in chips.
 *
 * Returns 0 when the row says nothing at all (no blinds AND no columns), which
 * the caller must read as UNKNOWN rather than as "free". A table we cannot
 * price is not a table anyone should be evicted from for being unable to pay.
 */
export function cashMinBuyIn(row: CashBuyInSource | null | undefined): number {
  if (!row) return 0;
  const rowMin = positive(row.min_buy_in);
  if (rowMin > 0) return rowMin;
  const bb = positive(row.big_blind);
  if (bb <= 0) return 0;
  return bb * CASH_MIN_BB;
}
