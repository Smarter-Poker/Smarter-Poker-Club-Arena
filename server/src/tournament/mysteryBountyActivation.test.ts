/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY ACTIVATION — when the chests may open, and when they may not
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan's sections 1, 2 and 3. Three conditions, all required:
 *
 *   (a) entry is closed — otherwise the pool is still growing and the
 *       inventory would be built from less money than the event ends up with;
 *   (b) the configured threshold is reached;
 *   (c) no table anywhere has a hand in progress — a player who committed his
 *       stack when a knockout was worth a flat bounty must not find, when the
 *       hand is scored, that it was worth a chest.
 *
 * Every one of these is a way to move money to the wrong place, so each gets a
 * test proving the predicate REFUSES, not just one proving it accepts.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldActivateMysteryBounty,
  mysteryBountyThresholdReached,
  mysteryPoolCents,
  type MysteryBountyActivationInputs,
} from './mysteryBountyActivation.js';
import { CHIP_UNIT_CENTS } from './tournamentUnit.js';

const base: MysteryBountyActivationInputs = {
  isMysteryBounty: true,
  stage: 'pending',
  entryClosed: true,
  allTablesBetweenHands: true,
  playersRemaining: 27,
  totalEntries: 180,
  paidPlaces: 27,
  mode: 'at_the_money',
  modeValue: null,
  mysteryPoolCents: 250_000,
};

describe('mystery bounty activation predicate', () => {
  /* TEST 13 — the happy path, and the chest count that comes out of it.

     CORRECTED 2026-08-25. This asserted 27 chests for 27 survivors, which is
     the shape the first build shipped and is NOT what the spec says. Section
     8, verbatim: "Number Of Mystery Bounty Draws = Players Remaining At
     Mystery Bounty Activation - 1 ... Do not generate an unused bounty for the
     eventual winner." One chest per ELIMINATION still to happen, not one per
     player standing. */
  it('opens at the money, with one chest per elimination still to come', () => {
    const d = shouldActivateMysteryBounty(base);
    expect(d.activate).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.drawCount).toBe(26);
  });

  // Dan's worked example, section 8: 150 remaining generates 149 draws.
  it("matches the spec's own worked example: 150 remaining, 149 draws", () => {
    const d = shouldActivateMysteryBounty({
      ...base,
      playersRemaining: 150,
      totalEntries: 1000,
      paidPlaces: 150,
    });
    expect(d.activate).toBe(true);
    expect(d.drawCount).toBe(149);
  });

  // With N-1 chests there is nothing left to generate once the champion is the
  // only player standing, and a heads-up field asks for exactly one chest.
  it('refuses a field of one, and funds a heads-up field with a single chest', () => {
    expect(shouldActivateMysteryBounty({ ...base, playersRemaining: 1 }).reason).toBe('no_players');
    const heads = shouldActivateMysteryBounty({
      ...base,
      playersRemaining: 2,
      paidPlaces: 2,
    });
    expect(heads.activate).toBe(true);
    expect(heads.drawCount).toBe(1);
  });

  // TEST 14 — (a). The single most expensive mistake available here: a pool
  // that is still growing.
  it('REFUSES while entry is still open, even at the threshold', () => {
    const d = shouldActivateMysteryBounty({ ...base, entryClosed: false });
    expect(d.activate).toBe(false);
    expect(d.reason).toBe('entry_still_open');
  });

  // TEST 15 — (c). Deliberately reported LAST, so a transient does not mask a
  // permanent reason in the log for the whole tournament.
  it('REFUSES mid-hand, and says so only when nothing else is wrong', () => {
    expect(shouldActivateMysteryBounty({ ...base, allTablesBetweenHands: false }).reason).toBe(
      'hand_in_progress'
    );
    // Entry open AND mid-hand reports the entry, which is the real problem.
    expect(
      shouldActivateMysteryBounty({
        ...base,
        allTablesBetweenHands: false,
        entryClosed: false,
      }).reason
    ).toBe('entry_still_open');
  });

  // TEST 16 — idempotency at the predicate level. The engine's sweep runs every
  // five seconds and a redeploy re-runs it; seeding twice would double the
  // inventory and the event could never reconcile.
  it('REFUSES once the phase has already opened or finished', () => {
    expect(shouldActivateMysteryBounty({ ...base, stage: 'active' }).reason).toBe(
      'already_activated'
    );
    expect(shouldActivateMysteryBounty({ ...base, stage: 'complete' }).reason).toBe(
      'already_activated'
    );
  });

  it('REFUSES a non-mystery tournament and an empty pool', () => {
    expect(shouldActivateMysteryBounty({ ...base, isMysteryBounty: false }).reason).toBe(
      'not_a_mystery_bounty'
    );
    expect(shouldActivateMysteryBounty({ ...base, mysteryPoolCents: 0 }).reason).toBe('empty_pool');
    expect(shouldActivateMysteryBounty({ ...base, playersRemaining: 0 }).reason).toBe('no_players');
  });
});

describe('mystery bounty threshold modes', () => {
  // TEST 17 — the three modes, including their misconfigured forms. A zero
  // that reads as "open immediately" would blow the chests on the first hand
  // of the event, before a single bounty had been funded by a late entry.
  it('at_the_money fires on the bubble and not before', () => {
    expect(mysteryBountyThresholdReached('at_the_money', null, 28, 180, 27)).toBe(false);
    expect(mysteryBountyThresholdReached('at_the_money', null, 27, 180, 27)).toBe(true);
    expect(mysteryBountyThresholdReached('at_the_money', null, 9, 180, 27)).toBe(true);
    // A structure with no paid places is unusable; refuse rather than guess.
    expect(mysteryBountyThresholdReached('at_the_money', null, 27, 180, 0)).toBe(false);
  });

  it('percent_field rounds UP, so nobody busts for a flat bounty at the boundary', () => {
    // 20% of 27 is 5.4. Rounding down would open the chests at 5 players —
    // one bustout after the advertised moment.
    expect(mysteryBountyThresholdReached('percent_field', 20, 7, 27, 3)).toBe(false);
    expect(mysteryBountyThresholdReached('percent_field', 20, 6, 27, 3)).toBe(true);
    expect(mysteryBountyThresholdReached('percent_field', 0, 6, 27, 3)).toBe(false);
    expect(mysteryBountyThresholdReached('percent_field', 20, 6, 0, 3)).toBe(false);
  });

  it('player_count fires at the configured count and refuses a zero', () => {
    expect(mysteryBountyThresholdReached('player_count', 27, 28, 180, 9)).toBe(false);
    expect(mysteryBountyThresholdReached('player_count', 27, 27, 180, 9)).toBe(true);
    expect(mysteryBountyThresholdReached('player_count', 0, 5, 180, 9)).toBe(false);
    expect(mysteryBountyThresholdReached('player_count', null, 5, 180, 9)).toBe(false);
  });
});

describe('mysteryPoolCents', () => {
  // TEST 18 — the split between the mystery half and the regular half, and
  // what happens when a club types two numbers that do not add up.
  it('takes the configured share of the bounty pool', () => {
    expect(mysteryPoolCents(100_000, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(50_000);
    expect(mysteryPoolCents(100_000, 70, 30, 0, CHIP_UNIT_CENTS)).toBe(70_000);
    expect(mysteryPoolCents(100_000, 100, 0, 0, CHIP_UNIT_CENTS)).toBe(100_000);
  });

  it('normalises percentages that do not sum to 100 rather than overpaying', () => {
    // 60 and 60 is a 50/50 split, not an event that pays out 120% of its pool.
    expect(mysteryPoolCents(100_000, 60, 60, 0, CHIP_UNIT_CENTS)).toBe(50_000);
  });

  it('floors, so the odd cent stays in the regular half', () => {
    // The regular half is spent against a live exhaustion check; the mystery
    // half is committed to a fixed inventory and an extra cent there would
    // leave the event unable to reconcile.
    expect(mysteryPoolCents(1001, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(500);
  });

  it('returns nothing for an empty or nonsensical pool', () => {
    expect(mysteryPoolCents(0, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(0);
    expect(mysteryPoolCents(-5, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(0);
    expect(mysteryPoolCents(100_000, 0, 0, 0, CHIP_UNIT_CENTS)).toBe(0);
  });
});
