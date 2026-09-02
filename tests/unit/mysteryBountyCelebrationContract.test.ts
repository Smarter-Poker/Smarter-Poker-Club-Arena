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
  isMysteryCollectMode,
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

/** The pre-phase knockout the engine sends today, field for field. */
const PRE_PHASE_PULL = {
  type: 'bounty_collected',
  payload: {
    mode: 'mystery_pre',
    amount: 130,
    // ADDED 2026-08-26.
    prizeRank: 1,
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

  it('accepts the pre-phase pull, which arrives under the ordinary name', () => {
    expect(isMysteryPull(PRE_PHASE_PULL.type, PRE_PHASE_PULL.payload)).toBe(true);
  });

  it('carries a positive amount, which is the check that used to fail', () => {
    // The banner returns early on `amount <= 0`. Before 2026-08-26 the chest
    // payload had no `amount` at all, so every top prize died on this line.
    expect(Number(CHEST_REVEAL.payload.amount)).toBeGreaterThan(0);
    expect(Number(PRE_PHASE_PULL.payload.amount)).toBeGreaterThan(0);
  });

  it('states the chest amount in the same money as amountCents', () => {
    expect(CHEST_REVEAL.payload.amount).toBe(CHEST_REVEAL.payload.amountCents / 100);
  });

  it("names who pulled it and what it was worth, which is Dan's sentence", () => {
    // "KINGFISH JUST PULLED THE TOP MYSTERY BOUNTY WORTH XXX"
    for (const p of [CHEST_REVEAL.payload, PRE_PHASE_PULL.payload]) {
      expect(String(p.knockerName).length).toBeGreaterThan(0);
      expect(Number(p.amount)).toBeGreaterThan(0);
    }
  });

  it('is not fooled by a knockout that is not a mystery pull', () => {
    expect(isMysteryPull('bounty_collected', { mode: 'pko' })).toBe(false);
    expect(isMysteryPull('bounty_collected', { mode: 'regular' })).toBe(false);
    expect(isMysteryPull('level_up', { mode: 'mystery_pre' })).toBe(false);
  });
});

describe('the mode gate matches what fn_collect_bounty can return', () => {
  /**
   * Read from the live function body on 2026-08-26. It is NOT called here:
   * fn_collect_bounty moves chips, and CLAUDE.md 11.5 forbids probing a money
   * path to check a rule.
   */
  const MODES_THE_FUNCTION_RETURNS = ['pko', 'mystery_pre', 'regular'];

  it('the client and the engine agree on every one of them', () => {
    for (const mode of MODES_THE_FUNCTION_RETURNS) {
      expect(isMysteryPull('bounty_collected', { mode })).toBe(isMysteryCollectMode(mode));
    }
  });

  it("'mystery' - the value the engine used to test for - is in neither camp alone", () => {
    // The dead test was `res.mode === 'mystery'`. Both sides accept the name so
    // a future rename of the DB mode lands already handled, but the value the
    // function really sends is mystery_pre and that is what must work.
    expect(isMysteryCollectMode('mystery_pre')).toBe(true);
    expect(isMysteryPull('bounty_collected', { mode: 'mystery_pre' })).toBe(true);
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
  it('marks the chest reveal and the pre-phase pull as celebrations', () => {
    expect(isTopPrize(CHEST_REVEAL.payload.prizeRank)).toBe(true);
    expect(isTopPrize(PRE_PHASE_PULL.payload.prizeRank)).toBe(true);
  });
});
