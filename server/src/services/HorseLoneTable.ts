/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NO LONE HORSE (CLAUDE.md 10.5, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured on production at 15:22 CDT: of 140 live cash-cluster tables, 47
 * held EXACTLY ONE horse (46 of them the only table of their game), seated for
 * 253 minutes on average, 39 of them with no hand dealt in thirty minutes. 26
 * more held two. The lobby therefore showed dozens of games with "1" player
 * where nothing was happening.
 *
 * Two mechanisms produced it, and neither was a rule anybody wrote down:
 *
 *  - the fleet's vibe target (`occupancyTargetFor`) can be 1 for a sparse
 *    table, and the 1-2 per cycle trickle can leave a table at 1. Once the
 *    target is met the fleet adds nobody, so the table sits at one forever;
 *  - the rotator's population floor (`tableSeats.length < 4 -> continue`)
 *    skips any table that would go to zero, so the lone horse is never stood.
 *
 * A lone player cannot deal a hand. A human alone at a table nobody has joined
 * for ten minutes leaves; the game goes dormant (OPORD 18.4) and its Main 1
 * stays open with 0, which is the designed state. Under 10.5 the fleet is the
 * horse's input device and may decide exactly what a human would decide - and
 * the OPORD asks the same of humans at the door (a one-buyer opening hold
 * waits for a partner; no ghost table).
 *
 * This file is the DECISION half, pure so it can be tested. The wiring is in
 * HorseFleetManager (seeding) and HorseSessionRotator (standing), and both go
 * through the doors a human uses: atomic_table_buyin and engine.leaveTable().
 */

/** A table needs this many to deal. Below it, it is a ghost table. */
export const DEALABLE_MINIMUM = 2;

/**
 * How long a horse sits alone at a cluster table with no hand dealt before it
 * leaves. Ten minutes is what a person gives an empty table before racking up:
 * long enough that a partner arriving from the lobby or a must-move finds them
 * still there, short enough that the lobby does not show a "1" for an hour.
 */
export const LONE_TABLE_MINUTES = 10;

/**
 * An `opening` feeder is being filled by the fleet on purpose; the controller
 * promotes it at two seated and abandons an empty one at three minutes. A
 * horse alone on one younger than this is waiting for a partner the fleet is
 * about to seat, not sitting at a dead table.
 */
export const OPENING_FEEDER_GRACE_MINUTES = 3;

export interface SeedPlan {
  /** The table belongs to a must-move game (`tables.cluster_id` set). */
  clusterTable: boolean;
  /** Occupied seats plus pending arrivals (a planned arrival holds its seat). */
  currentCount: number;
  /** What the trickle / vibe / budget arithmetic wants to seat this cycle. */
  seatsNeeded: number;
  /** The most the target and the per-table cap allow this cycle. */
  seatsAllowed: number;
}

/**
 * THE SEEDING FLOOR. A cluster table at 0 or 1 is brought to DEALABLE_MINIMUM
 * this cycle if the cap allows it, whatever the trickle said - the same rule
 * the opening feeder already had, applied to every cluster table. A table
 * already at two or more keeps its trickle; a non-cluster table is untouched.
 * Never exceeds `seatsAllowed`, so a cap of one is still a cap of one (and the
 * refusal below then keeps the single seat empty).
 */
export function seatsToDealable(plan: SeedPlan): number {
  if (!plan.clusterTable) return plan.seatsNeeded;
  if (plan.currentCount >= DEALABLE_MINIMUM) return plan.seatsNeeded;
  const toDealable = Math.min(plan.seatsAllowed, DEALABLE_MINIMUM - plan.currentCount);
  return Math.max(plan.seatsNeeded, toDealable);
}

export interface LoneSeatAsk {
  clusterTable: boolean;
  /** Occupied seats plus pending arrivals at the moment of seating. */
  currentCount: number;
  /** Horses that passed the sit verdict for this table this cycle. */
  sittable: number;
}

/**
 * THE REFUSAL. An EMPTY cluster table is seated to two or not at all: one
 * horse alone on it could not deal, and would sit there as the "1" the lobby
 * showed for 253 minutes. A table already holding one (or with a partner
 * pending) is a different case - one more makes it dealable, so it is seated.
 */
export function refusesLoneSeat(ask: LoneSeatAsk): boolean {
  return ask.clusterTable && ask.currentCount === 0 && ask.sittable < DEALABLE_MINIMUM;
}

export interface LoneStandSituation {
  clusterTable: boolean;
  /** Open seats at the table right now, the horse included. */
  seatedCount: number;
  /** Somebody at the table is a person - then the horse is their opponent. */
  humanPresent: boolean;
  /** A must-move / seat-change INTO this table is pending - a partner is coming. */
  inboundPending: boolean;
  lifecycle: string | null | undefined;
  /** Minutes since the table row was created. */
  tableAgeMinutes: number;
  /** Minutes since this horse sat down here. */
  minutesSeated: number;
  /** Minutes since the last hand recorded at this table; null when none was. */
  minutesSinceLastHand: number | null;
}

export type LoneStandVerdict =
  | 'stand'
  | 'not_cluster'
  | 'not_alone'
  | 'human_present'
  | 'partner_inbound'
  | 'opening_grace'
  | 'too_soon'
  | 'hand_dealt_recently';

/**
 * THE STAND. A horse that has been the only player at a cluster table for
 * LONE_TABLE_MINUTES with no hand dealt in that time gets up, through the same
 * door a human uses. The population floor in the rotator does NOT veto this:
 * a table at one is already below any floor, and going to zero makes the game
 * dormant, which is the designed state.
 *
 * The exemptions are the ones a person would also honour: an opponent is
 * seated (then you are their game), a partner is on the way (a pending move
 * into the table), or the table only just opened and the fleet is filling it.
 */
export function loneStandVerdict(s: LoneStandSituation): LoneStandVerdict {
  if (!s.clusterTable) return 'not_cluster';
  if (s.seatedCount !== 1) return 'not_alone';
  if (s.humanPresent) return 'human_present';
  if (s.inboundPending) return 'partner_inbound';
  if (s.lifecycle === 'opening' && s.tableAgeMinutes < OPENING_FEEDER_GRACE_MINUTES) {
    return 'opening_grace';
  }
  if (s.minutesSeated < LONE_TABLE_MINUTES) return 'too_soon';
  if (s.minutesSinceLastHand !== null && s.minutesSinceLastHand < LONE_TABLE_MINUTES) {
    return 'hand_dealt_recently';
  }
  return 'stand';
}
