/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY — WHEN THE MYSTERY PHASE OPENS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sections 1, 2 and 3. Activation needs THREE things to be true at once, and
 * every one of them exists because getting it wrong costs real money:
 *
 *   (a) ENTRY IS CLOSED. Late registration, rebuys, re-entries and the add-on
 *       window must all be finished. Until they are, `tournaments.bounty_pool`
 *       is still growing — every new entry adds to it — so an inventory seeded
 *       before the close would be built from a pool smaller than the one the
 *       event ends up holding, and the difference could never be paid out. The
 *       engine already has exactly one flag that means "the pool has stopped
 *       moving": `prize_pool_finalized`, which is set at the three sites that
 *       close the entry window (start with no late reg, the level that passes
 *       the late-reg cap, and finalizeAfterAddOn). It is the same close for
 *       the bounty pool as for the prize pool, so it is the same flag.
 *
 *   (b) THE THRESHOLD IS REACHED. Whichever of the three configured modes the
 *       club chose. Below the threshold, knockouts pay the ordinary bounty out
 *       of the regular half of the pool; from here on they open chests.
 *
 *   (c) NO CARDS ARE IN THE AIR ANYWHERE. Activation may only flip BETWEEN
 *       hands. A player who committed his stack while a knockout was worth a
 *       flat 5 must not find, when the hand is scored, that it was worth a
 *       chest — that is the information changing under a decision already
 *       made. Because the flip is global (one inventory for the whole event),
 *       "between hands" means every table, not just one.
 *
 * The predicate is a pure function so it can be tested without a tournament,
 * a database or a clock. The engine hook underneath it does nothing but gather
 * the inputs.
 */

/**
 * The one unit floor, imported rather than written a second time. recoveryFee
 * is a dependency-free leaf, so this adds no cycle to a module that had no
 * imports at all; writing the floor out again here would recreate exactly the
 * drift this Phase 8 work exists to remove.
 */
import { unitFloorCents } from './recoveryFee.js';

export type MysteryBountyActivationMode = 'at_the_money' | 'percent_field' | 'player_count';

export type MysteryBountyStage = 'pending' | 'active' | 'complete';

export interface MysteryBountyActivationInputs {
  /** Is this a mystery bounty tournament at all? */
  readonly isMysteryBounty: boolean;
  /** `tournaments.mystery_bounty_stage`. Only 'pending' can activate. */
  readonly stage: MysteryBountyStage;
  /** `prize_pool_finalized` — the single flag meaning entry is closed. */
  readonly entryClosed: boolean;
  /** True only when no table in the event has a hand in progress. */
  readonly allTablesBetweenHands: boolean;
  /** Players who can still be knocked out right now. */
  readonly playersRemaining: number;
  /** Total entries the event took, including rebuys and re-entries. */
  readonly totalEntries: number;
  /** How many places the payout structure pays. Used by 'at_the_money'. */
  readonly paidPlaces: number;
  readonly mode: MysteryBountyActivationMode;
  /** Percent for 'percent_field', an absolute count for 'player_count'. */
  readonly modeValue: number | null | undefined;
  /** The mystery half of the bounty pool, in cents. Nothing to draw if zero. */
  readonly mysteryPoolCents: number;
}

export interface MysteryBountyActivationDecision {
  readonly activate: boolean;
  /** Why not, for the log. `null` when activating. */
  readonly reason:
    | null
    | 'not_a_mystery_bounty'
    | 'already_activated'
    | 'entry_still_open'
    | 'hand_in_progress'
    | 'threshold_not_reached'
    | 'no_players'
    | 'empty_pool';
  /** How many chests to build. Meaningful only when `activate` is true. */
  readonly drawCount: number;
}

/**
 * Has the configured threshold been crossed?
 *
 * Exported separately because the lobby wants to show "chests open at 27
 * players" without asking whether a hand is in progress.
 */
export function mysteryBountyThresholdReached(
  mode: MysteryBountyActivationMode,
  modeValue: number | null | undefined,
  playersRemaining: number,
  totalEntries: number,
  paidPlaces: number
): boolean {
  if (playersRemaining <= 0) return false;
  switch (mode) {
    case 'player_count': {
      const target = Math.floor(Number(modeValue) || 0);
      // A misconfigured zero must not open the chests on the first hand of the
      // event; treat it as "not configured" and refuse.
      if (target <= 0) return false;
      return playersRemaining <= target;
    }
    case 'percent_field': {
      const pct = Number(modeValue) || 0;
      if (pct <= 0 || totalEntries <= 0) return false;
      // Ceil, not round: "the last 20%" of a 27-entry field is 6 players, and
      // rounding down would open the chests one bustout late, after somebody
      // had already been knocked out for a flat bounty at the boundary.
      return playersRemaining <= Math.ceil((totalEntries * pct) / 100);
    }
    case 'at_the_money':
    default: {
      // The bubble bursts when the field reaches the number of paid places.
      // A structure with no paid places is unusable; refuse rather than guess.
      if (paidPlaces <= 0) return false;
      return playersRemaining <= paidPlaces;
    }
  }
}

/** The whole predicate. Pure. */
export function shouldActivateMysteryBounty(
  input: MysteryBountyActivationInputs
): MysteryBountyActivationDecision {
  const no = (reason: MysteryBountyActivationDecision['reason']) => ({
    activate: false,
    reason,
    drawCount: 0,
  });

  if (!input.isMysteryBounty) return no('not_a_mystery_bounty');
  if (input.stage !== 'pending') return no('already_activated');
  if (!input.entryClosed) return no('entry_still_open');
  /* <= 1, not <= 0. With N-1 chests a heads-up field would ask for one chest
     and a one-player field for zero, and an event that is already down to its
     champion has no eliminations left to pay for. Refuse rather than seed an
     empty inventory the settle step would then have to reason about. */
  if (input.playersRemaining <= 1) return no('no_players');
  if (input.mysteryPoolCents <= 0) return no('empty_pool');
  if (
    !mysteryBountyThresholdReached(
      input.mode,
      input.modeValue,
      input.playersRemaining,
      input.totalEntries,
      input.paidPlaces
    )
  ) {
    return no('threshold_not_reached');
  }
  // Checked LAST, deliberately. Every other reason is stable — it will still
  // be the reason on the next sweep — but "a hand is in progress" is a
  // transient that resolves itself in seconds, and checking it first would
  // hide the real reason from the log for the whole tournament.
  if (!input.allTablesBetweenHands) return no('hand_in_progress');

  /* PLAYERS REMAINING, MINUS ONE. Dan's spec section 8, verbatim: "Number Of
     Mystery Bounty Draws = Players Remaining At Mystery Bounty Activation - 1
     ... Every remaining player except the eventual tournament winner will
     eventually be eliminated. Do not generate an unused bounty for the
     eventual winner."

     The first build generated one chest per SURVIVOR and settled the leftover
     to the champion as a residual. That is a different game: 150 players got
     150 chests, so the advertised ladder held one more prize than the event
     could ever award, every tier's published count was one too many somewhere,
     and the champion collected a chest nobody knocked them out of.

     N-1 also makes the invariant self-enforcing. There are exactly as many
     chests as there are eliminations left to happen, so the inventory empties
     at the moment the event reaches one player, and `sum(paid)` equals the
     pool without anything having to be swept up afterwards. */
  return { activate: true, reason: null, drawCount: input.playersRemaining - 1 };
}

/**
 * How the mystery pool is carved out of the bounty pool.
 *
 * The bounty pool is split in two. `regularPercent` funds ordinary knockouts
 * for the whole pre-activation phase; `mysteryPercent` funds the chests. They
 * are stored as two separate columns rather than one, because a club that sets
 * them to something other than 50/50 must be able to see both numbers, and
 * because a single column would leave the reader guessing which half it named.
 *
 * They are normalised here rather than trusted: if they do not sum to 100 the
 * mystery half is taken as its share of whatever they DO sum to, so a club
 * that types 60 and 60 gets a 50/50 split rather than an event that tries to
 * pay out 120% of its bounty pool.
 */
export function mysteryPoolCents(
  bountyPoolCents: number,
  mysteryPercent: number | null | undefined,
  regularPercent: number | null | undefined,
  /**
   * ═══ 2026-08-28: THE CAP THE DATABASE APPLIES AND THE ENGINE DID NOT ═════
   *
   * MEASURED IN PRODUCTION. `fn_mystery_bounty_seed` refused 23 times in 24
   * hours with `inventory_mismatch`, and ZERO mystery bounties have ever been
   * awarded: 104 chests worth $1,833 created across 27 completed events, all
   * of them voided, `tournament_bounty_awards` completely empty. Every
   * knockout kept paying the flat pre-activation bounty instead.
   *
   * The seed function reduces the mystery half by whatever the REGULAR half
   * has already paid out:
   *
   *     IF v_pool_cents > v_bounty_cents - bounty_pool_paid THEN
   *       v_pool_cents := GREATEST(0, v_bounty_cents - bounty_pool_paid)
   *
   * The engine built its chest list from the UNREDUCED number, so the moment
   * a single pre-activation knockout had been paid the two disagreed and the
   * seed was refused - which produced more flat knockouts, which grew
   * bounty_pool_paid, which guaranteed the next attempt failed too. A
   * self-reinforcing loop that no mystery bounty could ever escape.
   *
   * Applying the identical cap here is the whole fix. Passing 0 (or nothing)
   * reproduces the old arithmetic exactly, which is what the unit tests
   * written before this parameter existed still assert.
   */
  alreadyPaidCents: number = 0,
  /**
   * ═══ 2026-09-12: THE SMALLEST AMOUNT THIS TOURNAMENT CAN PAY ════════════
   *
   * One cent for a chip tournament, which is every tournament that has ever
   * run, and which is why this defaults to 1: `Math.floor(x / 1) * 1` is `x`,
   * so the chip half is unchanged BY CONSTRUCTION rather than by inspection,
   * exactly as passing 0 for alreadyPaidCents above reproduces the older
   * arithmetic.
   *
   * One hundred for a Diamond tournament, because a Diamond does not divide.
   * The comment below says the regular half keeps the odd cent; at a Diamond
   * unit it keeps the odd Diamond, for precisely the same reason. The mystery
   * half is committed to a fixed inventory up front, so a fraction there
   * leaves the event unable to reconcile, and a fraction of a Diamond is not
   * an amount any door in this estate will accept.
   *
   * NO CALLER PASSES THIS YET. Reading it means the manager knowing its
   * tournament's unit, which belongs with the work that opens the Diamond
   * tournament door rather than with the arithmetic.
   */
  unitCents: number = 1
): number {
  if (!Number.isInteger(bountyPoolCents) || bountyPoolCents <= 0) return 0;
  const m = Math.max(0, Number(mysteryPercent ?? 50) || 0);
  const r = Math.max(0, Number(regularPercent ?? 50) || 0);
  const total = m + r;
  if (total <= 0) return 0;
  // Floor: the regular half keeps the odd cent. It is spent knockout by
  // knockout against a pool that is checked for exhaustion on every payment,
  // whereas the mystery half is committed to a fixed inventory up front and
  // an extra cent there would leave the event unable to reconcile.
  const half = unitFloorCents(Math.floor((bountyPoolCents * m) / total), unitCents);
  const paid = Math.max(0, Math.round(Number(alreadyPaidCents) || 0));
  // The same GREATEST(0, ...) the seed applies, in the same order. The cap is
  // floored to the unit too: a pool that has already paid part of itself out
  // need not leave a whole unit behind, and a cap that is not on the grid is
  // not a cap the inventory can be built against.
  return unitFloorCents(Math.max(0, Math.min(half, bountyPoolCents - paid)), unitCents);
}
