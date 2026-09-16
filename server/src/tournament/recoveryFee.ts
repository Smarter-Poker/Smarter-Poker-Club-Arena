/**
 * The fee on a rebuy or a re-entry.
 *
 * Deliberately a standalone module with NO imports, for the same reason
 * payoutMath.ts is one: the quote that reads it lives in a service that
 * already pulls in half the engine, and a rule about money should not be
 * reachable only through that. A dependency-free leaf can be imported by a
 * test, by the quote, and by anything the Diamond door adds later, without a
 * cycle to reason about.
 *
 * THE RULE, and why it is written three times in SQL and once here rather
 * than four times in SQL. Until 2026-09-12 it was written four times in SQL
 * and once here, and nothing held any of them together:
 *
 *   fn_ca_tournament_charge_split                   (the refund authority)
 *   fn_ca_process_tournament_chip_purchase_money_v1 (the charge itself)
 *   fn_ca_tournament_escrow                         (inline, inside a query)
 *   tournamentPurchaseQuote                         (this side)
 *
 * Migration 20260912103907 collapsed the SQL three into fn_ca_recovery_fee_cents.
 * This module is the other half, and oneRecoveryFeeTwoLanguages.law.test.ts is
 * the bond between them: its vectors are produced BY the SQL, so this fails
 * when the TypeScript drifts away from the database.
 */

/**
 * An amount of cents floored to a whole unit.
 *
 * `Math.floor(x / 1) * 1` is `x`, which is the whole reason the chip path is
 * unchanged by construction rather than by inspection.
 */
export function unitFloorCents(cents: number, unitCents = 1): number {
  const unit = Number.isSafeInteger(unitCents) && unitCents >= 1 ? unitCents : 1;
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.floor(cents / unit) * unit;
}

/**
 * The ratio a recovery fee is charged at, derived from the buy-in and its fee.
 *
 * Reproduced exactly, including the ten percent fallback when a tournament
 * carries no fee at all. The SQL guard COALESCEs and its division does not, so
 * a NULL buy-in with a positive fee yields NULL there; no tournament in the
 * database has a NULL buy-in or fee, so the two agree everywhere reachable.
 */
export function tournamentFeeRatio(buyIn: number, buyInFee: number): number {
  const a = Number.isFinite(buyIn) ? buyIn : 0;
  const f = Number.isFinite(buyInFee) ? buyInFee : 0;
  return a + f > 0 && f > 0 ? f / (a + f) : 0.1;
}

/**
 * The recovery fee, in cents: the ratio, capped at ten percent, truncated
 * DOWN to the smallest amount this tournament can pay.
 *
 * THE EPSILON IS NOT DECORATION. `gross * ratio` lands a hair under a whole
 * cent for ratios that are exact in decimal but not in binary, and without it
 * the fee truncates a cent low. It is kept at exactly the value the SQL keeps
 * it at, because the two have to agree on the boundary and not merely near it.
 *
 * The cap is floored to the unit as well. A cap that is not on the grid is not
 * a cap the fee can honour.
 */
export function recoveryFeeCents(grossCents: number, feeRatio: number, unitCents = 1): number {
  if (!Number.isFinite(grossCents) || grossCents <= 0) return 0;
  if (!Number.isFinite(feeRatio) || feeRatio <= 0) return 0;
  return Math.min(
    unitFloorCents(Math.trunc(grossCents * feeRatio + 0.000001), unitCents),
    unitFloorCents(Math.trunc(grossCents * 0.1 + 0.000001), unitCents)
  );
}
