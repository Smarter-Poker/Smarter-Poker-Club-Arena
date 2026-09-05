/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BARRED HORSE IS NOT A BUYER (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `public.cash_rejoin_constraints` carries two rules a cash player meets at
 * the door of a game (club + variant + sb + bb, the key the floor uses):
 *
 *   - `barred_until`  - booted for low VPIP: NO seat in this game until it
 *                       lifts (fn_cash_rejoin_floor raises VPIP_BARRED);
 *   - `required_stack` - the rathole floor: you may not rejoin the same game
 *                       with less than you left with, while `expires_at`
 *                       holds (atomic_table_buyin raises BUYIN_BELOW_FLOOR).
 *
 * A human sees both in the lobby and the buy-in modal
 * (fn_cash_effective_buyin) and does not try a barred game. The fleet is the
 * horse's browser (CLAUDE.md 10.5), and until today it knew about neither:
 * barred horses passed every in-memory gate, were counted as buyers, were
 * selected, and were refused by the database - 341 of 349 buy-in refusals in
 * one hour were VPIP_BARRED, from 35 horses holding 57 active bars.
 *
 * This module reads the rows into the two shapes the fleet consults, keyed
 * exactly as the SQL joins them. Pure, so it can be proven without a database.
 */

export interface RejoinConstraintRow {
  player_id: string;
  club_id: string;
  variant: string;
  sb: number | string;
  bb: number | string;
  required_stack: number | string | null;
  barred_until: string | null;
  expires_at: string;
}

export interface RejoinConstraints {
  /** `${player_id}|${tableKey}` for every bar still in force. */
  barred: Set<string>;
  /** `${player_id}|${tableKey}` -> the highest floor still in force. */
  rejoinFloor: Map<string, number>;
}

/**
 * The game key, formatted the way BOTH sides must format it. `sb`/`bb` are
 * numeric(14,2) in Postgres and arrive as strings ("0.50"); the table row
 * may carry them as numbers (0.5). Number() on both sides makes "0.50" and
 * 0.5 the same key.
 */
export function rejoinTableKey(t: {
  club_id?: string | null;
  game_variant?: string | null;
  small_blind?: number | string | null;
  big_blind?: number | string | null;
}): string {
  return `${t.club_id ?? ''}|${t.game_variant ?? ''}|${Number(t.small_blind)}|${Number(t.big_blind)}`;
}

export function rejoinPlayerKey(playerId: string, tableKey: string): string {
  return `${playerId}|${tableKey}`;
}

export const EMPTY_REJOIN_CONSTRAINTS: RejoinConstraints = {
  barred: new Set(),
  rejoinFloor: new Map(),
};

export function buildRejoinConstraints(
  rows: readonly RejoinConstraintRow[],
  nowMs: number = Date.now()
): RejoinConstraints {
  const barred = new Set<string>();
  const rejoinFloor = new Map<string, number>();
  for (const r of rows) {
    const expires = Date.parse(r.expires_at);
    if (!Number.isFinite(expires) || expires <= nowMs) continue;
    const key = rejoinPlayerKey(
      r.player_id,
      rejoinTableKey({
        club_id: r.club_id,
        game_variant: r.variant,
        small_blind: r.sb,
        big_blind: r.bb,
      })
    );
    const barredUntil = r.barred_until ? Date.parse(r.barred_until) : NaN;
    if (Number.isFinite(barredUntil) && barredUntil > nowMs) barred.add(key);
    const floor = Number(r.required_stack);
    if (Number.isFinite(floor) && floor > 0) {
      const prev = rejoinFloor.get(key) ?? 0;
      if (floor > prev) rejoinFloor.set(key, floor);
    }
  }
  return { barred, rejoinFloor };
}

/**
 * The buy-in a player with a rejoin floor actually pays, as
 * fn_cash_effective_buyin computes it for the modal: GREATEST(min, floor),
 * then LEAST(that, max). The floor can only ever RAISE a buy-in, and never
 * past the table's max - the database clamps the same way, so a floor above
 * max is "buy in for the max", not a refusal.
 */
export function applyRejoinFloor(
  buyIn: number,
  floor: number | undefined,
  maxBuyIn: number
): number {
  if (floor === undefined || !Number.isFinite(floor) || floor <= buyIn) return buyIn;
  const eff = maxBuyIn > 0 ? Math.min(floor, maxBuyIn) : floor;
  return Math.max(buyIn, Math.round(eff * 100) / 100);
}
