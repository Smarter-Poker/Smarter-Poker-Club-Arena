/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SATELLITE AWARD ARITHMETIC — how a satellite pool becomes seats and cash
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TournamentManager.processSatelliteAwards on 2026-08-26,
 * unchanged in behaviour, because that method had NO test coverage at all and
 * its own comments record three separate money bugs already fixed in it:
 *
 *   - a raw INSERT that seated the winner and moved nothing else, destroying
 *     the chips players paid in and leaving the target's prize pool one buy-in
 *     short for every seat it took (2026-08-23);
 *   - a cash path that re-paid finishers on a recovery re-drive because it
 *     wrote no idempotency key (2026-07-28);
 *   - a remainder payment that silently swallowed itself by reusing the
 *     position-prize key when the remainder went to a player already paid.
 *
 * Every one of those was found in production. The decisions below are the
 * ones that decide who gets what, they are pure arithmetic, and they were
 * reachable only through a method that needs a database, four Supabase round
 * trips and a running tournament. Now they are a function.
 *
 * The same pattern the rest of this repo already uses for logic worth pinning:
 * `timedSpawnsDue`, `quickJoinRanking`, `tournamentScheduleWindow`. Pure on
 * purpose — no Supabase, no clock, no side effects. The caller fetches and
 * pays; this decides.
 */

export interface SatelliteAwardInput {
  /** The satellite's collected prize pool, in chips. */
  pool: number;
  /**
   * What one seat in the target costs (buy_in_amount + buy_in_fee).
   * ZERO when there is no target at all, or the target could not be read —
   * which is the signal that no seat can be awarded and everything is cash.
   */
  ticketCost: number;
  /**
   * `tournaments.satellite_seats` — the ADVERTISED guarantee. When set it
   * WINS over what the pool can afford, because that is what a guarantee is.
   * Zero/absent falls back to what the pool funds.
   */
  configuredSeats: number;
  /** How many players actually finished and can be awarded anything. */
  finisherCount: number;
}

export interface SatelliteAwardPlan {
  /** Seats (or cashed tickets) to hand out, best finisher first. */
  awardCount: number;
  /** Value of one seat. Each award is worth this much. */
  ticketCost: number;
  /** Cash left over after the seats, paid to the next finisher down. */
  remainder: number;
  /**
   * True when nothing can be awarded as a seat and the WHOLE pool goes to
   * first place as cash. Distinct from `awardCount === 0 && remainder > 0`,
   * which cannot happen — see the tests.
   */
  cashWholePoolToFirst: boolean;
  /**
   * What the guarantee costs the house beyond what the field paid in, in
   * chips. Zero on a healthy satellite. POSITIVE means the club is covering
   * the difference, which is the deliberate meaning of a guaranteed seat
   * count and the number worth watching when one is set.
   */
  overlay: number;
}

/** Chips are money: two decimal places, never a float tail. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Decide the split. Mirrors processSatelliteAwards exactly:
 *
 *   seats       = configured guarantee, else floor(pool / ticket), else none
 *   awardCount  = min(seats, finishers)   — cannot award to nobody
 *   remainder   = pool - awardCount * ticket, paid on only when positive
 *
 * NOTE THE ORDER OF THE TWO CAPS. The guarantee is NOT capped by the pool —
 * a guaranteed seat count is a promise to cover the shortfall, and capping it
 * would quietly turn "5 seats guaranteed" into "up to 5 seats". It IS capped
 * by the number of finishers, because a seat cannot be awarded to nobody.
 */
export function planSatelliteAwards(input: SatelliteAwardInput): SatelliteAwardPlan {
  const pool = Math.max(0, round2(Number(input.pool) || 0));
  const ticketCost = Math.max(0, round2(Number(input.ticketCost) || 0));
  const configuredSeats = Math.max(0, Math.floor(Number(input.configuredSeats) || 0));
  const finisherCount = Math.max(0, Math.floor(Number(input.finisherCount) || 0));

  /**
   * THE GUARANTEE IS A FLOOR, NOT A CAP (2026-08-30 satellite audit, phase 2).
   *
   * `configuredSeats` used to REPLACE the pool arithmetic outright, so a
   * satellite that out-sold its guarantee awarded only the guaranteed count
   * and dumped the surplus as cash to one finisher — a $10 "2 Seats
   * Guaranteed" event with 100 runners would seat 2 and cash 500 to 3rd.
   * A guarantee promises AT LEAST; a field that funds more seats gets them.
   */
  const seats = ticketCost > 0 ? Math.max(configuredSeats, Math.floor(pool / ticketCost)) : 0;
  const awardCount = Math.min(seats, finisherCount);
  const remainder = round2(pool - awardCount * ticketCost);

  return {
    awardCount,
    ticketCost,
    // A negative remainder is the house covering a guarantee, never a debt
    // collected from anybody, so it is not paid out and not reported here.
    remainder: remainder > 0 ? remainder : 0,
    cashWholePoolToFirst: awardCount === 0 && finisherCount > 0 && pool > 0,
    overlay: remainder < 0 ? round2(-remainder) : 0,
  };
}

/**
 * Who receives the leftover cash.
 *
 * The next finisher below the seats — or, when the seats consumed the whole
 * field, the last seat winner. Returns null when there is nothing to pay or
 * nobody to pay it to.
 *
 * This index is the reason the remainder needs its OWN idempotency namespace
 * in the caller: on a short field it resolves to a player who has already
 * been paid under `prize:{user}:{position}`, and reusing that key would dedupe
 * the remainder into nothing rather than deduping a double payment.
 */
export function remainderRecipientIndex(
  plan: SatelliteAwardPlan,
  finisherCount: number
): number | null {
  if (plan.remainder <= 0 || finisherCount <= 0) return null;
  return plan.awardCount < finisherCount ? plan.awardCount : plan.awardCount - 1;
}
