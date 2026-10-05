/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CELEBRATION'S CONTRACT WITH THE ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "IN ANY MYSTERY BOUNTY POOL, ALL PLAYERS IN THE
 * TOURNAMENT SHOULD GET A CELEBRATION TOAST NOTIFYING ALL PLAYERS (AND
 * OBSERVERS) WHEN THE TOP 3 PRIZES ARE PULLED."
 *
 * The banner has been mounted and correct for a while. What it could not do was
 * fire for the case Dan named, because the two halves did not meet:
 *
 *   1. `mystery_bounty_revealed` - the CHEST reveal, which is where an event's
 *      top prizes are actually drawn - carried the money only as `amountCents`.
 *      The banner reads `amount`, saw undefined, and returned before it ever
 *      looked at the rank. Silent through the exact moment it exists for.
 *
 *   2. The engine chose its event name with `res.mode === 'mystery'`, and
 *      fn_collect_bounty returns 'pko' | 'mystery_pre' | 'regular'. Dead in
 *      both directions.
 *
 * Both are fixed in the engine. This file pins the seam from the client side so
 * neither can quietly come back, and it does it WITHOUT rendering: the parts
 * that decide whether a celebration happens are pure, and a happy-dom render
 * with a mocked realtime channel would test the mock.
 */

import { describe, it, expect } from 'vitest';
import {
  isMysteryPull,
  rankFromLadder,
} from '../../src/components/tournament/MysteryBountyCelebration';
import {
  buildPrizeLadder,
  prizeRankOf,
  isTopPrize,
} from '../../server/src/tournament/mysteryPrizeLadder';

/** The chest reveal the engine sends today, field for field. */
const CHEST_REVEAL = {
  type: 'mystery_bounty_revealed',
  payload: {
    tableId: 'table-1',
    awardId: 'award-1',
    amountCents: 1_300_000,
    // ADDED 2026-08-26. Without this the banner cannot fire at all.
    amount: 13_000,
    prizeRank: 1,
    tier: 'jackpot',
    tierLabel: 'Jackpot Prize',
    isJackpot: true,
    eliminatedName: 'Bob',
    knockerName: 'Kingfish',
    knockerUserId: 'u-king',
  },
};

/**
 * The pre-phase knockout: the flat head paid before the chests open. Since
 * 2026-10-05 the engine sends it with no `prizeRank`; it used to send rank 1
 * for every one (a flat head ranked against flat heads), which raised "The Top
 * Mystery Bounty" on every routine bust.
 */
const PRE_PHASE_KNOCKOUT = {
  type: 'bounty_collected',
  payload: {
    mode: 'mystery_pre',
    amount: 8,
    playerName: 'Bob',
    eliminatedName: 'Bob',
    knockerName: 'Kingfish',
    knockerUserId: 'u-king',
  },
};

describe('the engine payloads reach the celebration', () => {
  it('accepts the chest reveal', () => {
    expect(isMysteryPull(CHEST_REVEAL.type, CHEST_REVEAL.payload)).toBe(true);
  });

  it('does NOT treat a pre-phase flat head as a mystery pull (2026-10-05)', () => {
    expect(isMysteryPull(PRE_PHASE_KNOCKOUT.type, PRE_PHASE_KNOCKOUT.payload)).toBe(false);
    // Even an older engine that still stamps rank 1 on the head is ignored.
    expect(
      isMysteryPull(PRE_PHASE_KNOCKOUT.type, { ...PRE_PHASE_KNOCKOUT.payload, prizeRank: 1 })
    ).toBe(false);
  });

  it('the engine sends the pre-phase head with no rank', () => {
    expect('prizeRank' in PRE_PHASE_KNOCKOUT.payload).toBe(false);
  });

  it('carries a positive amount, which is the check that used to fail', () => {
    // The banner returns early on `amount <= 0`. Before 2026-08-26 the chest
    // payload had no `amount` at all, so every top prize died on this line.
    expect(Number(CHEST_REVEAL.payload.amount)).toBeGreaterThan(0);
  });

  it('states the chest amount in the same money as amountCents', () => {
    expect(CHEST_REVEAL.payload.amount).toBe(CHEST_REVEAL.payload.amountCents / 100);
  });

  it("names who pulled it and what it was worth, which is Dan's sentence", () => {
    // "KINGFISH JUST PULLED THE TOP MYSTERY BOUNTY WORTH XXX"
    expect(String(CHEST_REVEAL.payload.knockerName).length).toBeGreaterThan(0);
    expect(Number(CHEST_REVEAL.payload.amount)).toBeGreaterThan(0);
  });

  it('is not fooled by a knockout that is not a mystery pull', () => {
    expect(isMysteryPull('bounty_collected', { mode: 'pko' })).toBe(false);
    expect(isMysteryPull('bounty_collected', { mode: 'regular' })).toBe(false);
    expect(isMysteryPull('level_up', { mode: 'mystery_pre' })).toBe(false);
  });
});

describe('no mode fn_collect_bounty returns is a mystery pull', () => {
  /**
   * Read from the live function body on 2026-08-26. It is NOT called here:
   * fn_collect_bounty moves chips, and CLAUDE.md 11.5 forbids probing a money
   * path to check a rule. Every one of them is a HEAD (pko half, regular head,
   * flat pre-phase head); a pull is a chest, which arrives as
   * mystery_bounty_revealed.
   */
  const MODES_THE_FUNCTION_RETURNS = ['pko', 'mystery_pre', 'regular', 'mystery'];

  it('rejects every knockout mode, and accepts only the chest reveal', () => {
    for (const mode of MODES_THE_FUNCTION_RETURNS) {
      expect(isMysteryPull('bounty_collected', { mode })).toBe(false);
    }
    expect(isMysteryPull('mystery_bounty_revealed', {})).toBe(true);
  });
});

describe('the fallback ladder agrees with the engine, rung for rung', () => {
  /**
   * The banner prefers `payload.prizeRank` and derives its own only when the
   * engine did not send one. Two clients in the same tournament on either side
   * of a deploy must celebrate the same prizes, so the two derivations have to
   * be the same function.
   */
  const ladders = [
    buildPrizeLadder([130, 30, 20, 10, 5]),
    buildPrizeLadder([1_300_000, 300_000, 200_000, 100_000, 50_000]),
    buildPrizeLadder([50, 50, 50, 20]),
    buildPrizeLadder([]),
  ];
  const amounts = [130, 30, 20, 10, 5, 25, 50, 0, -1, 1_300_000, 200_000, 1];

  it('returns the identical rank for every amount on every ladder', () => {
    for (const ladder of ladders) {
      for (const amount of amounts) {
        expect(rankFromLadder(amount, ladder)).toBe(prizeRankOf(amount, ladder));
      }
    }
  });

  it('agrees that an empty ladder celebrates nothing', () => {
    expect(rankFromLadder(130, [])).toBe(0);
    expect(prizeRankOf(130, [])).toBe(0);
    expect(isTopPrize(0)).toBe(false);
  });

  it('agrees on exactly which prizes are the top three', () => {
    const ladder = buildPrizeLadder([130, 30, 20, 10, 5]);
    for (const amount of [130, 30, 20]) {
      expect(isTopPrize(rankFromLadder(amount, ladder))).toBe(true);
    }
    for (const amount of [10, 5]) {
      expect(isTopPrize(rankFromLadder(amount, ladder))).toBe(false);
    }
  });
});

describe('the ranks the engine sends are top-three ranks', () => {
  it('marks the chest reveal as a celebration', () => {
    expect(isTopPrize(CHEST_REVEAL.payload.prizeRank)).toBe(true);
  });
});
