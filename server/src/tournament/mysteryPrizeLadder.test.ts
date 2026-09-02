/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE PRIZE LADDER, AND THE MODE THAT WAS NEVER THERE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These are the rules behind Dan's "WHEN THE TOP 3 PRIZES ARE PULLED", pinned
 * without touching a money path. `fn_collect_bounty` moves chips (CLAUDE.md
 * 11.5), so the mode list here is asserted against the function body READ from
 * production on 2026-08-26, never against a call.
 *
 * The regression this file exists to stop is the one it was written after: the
 * engine tested `res.mode === 'mystery'`, a value the function cannot return,
 * so a mystery event's celebration path was unreachable for months and nothing
 * failed loudly enough for anyone to notice.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPrizeLadder,
  prizeRankOf,
  isMysteryCollectMode,
  isTopPrize,
  MYSTERY_COLLECT_MODES,
  TOP_PRIZE_RANKS,
} from './mysteryPrizeLadder.js';

describe('buildPrizeLadder', () => {
  it('is distinct, largest first', () => {
    expect(buildPrizeLadder([10, 30, 10, 130, 20, 30])).toEqual([130, 30, 20, 10]);
  });

  it('drops a claimed head, which is stored as zero', () => {
    expect(buildPrizeLadder([0, 20, 0, 5])).toEqual([20, 5]);
  });

  it('drops anything that is not a positive number rather than poisoning the sort', () => {
    expect(buildPrizeLadder([null, undefined, 'x', NaN, -4, 12])).toEqual([12]);
  });

  it('reads the numeric strings PostgREST returns for a numeric column', () => {
    expect(buildPrizeLadder(['130.00', '30.00', '30.0'])).toEqual([130, 30]);
  });

  it('treats float dust as the same rung', () => {
    // 0.1 + 0.2 is 0.30000000000000004; a raw Set would make it a second rung.
    expect(buildPrizeLadder([0.1 + 0.2, 0.3])).toEqual([0.3]);
  });

  it('is empty for an empty event', () => {
    expect(buildPrizeLadder([])).toEqual([]);
  });
});

describe('prizeRankOf', () => {
  // The draw table from 20260821_mystery_bounty_true_advertised_range.sql on a
  // base of 10: 60% x0.5, 25% x1, 10% x2, 4% x3, 1% x13.
  const ladder = buildPrizeLadder([130, 30, 20, 10, 5]);

  it('gives the largest prize rank 1', () => {
    expect(prizeRankOf(130, ladder)).toBe(1);
  });

  it('walks down the rungs in order', () => {
    expect(prizeRankOf(30, ladder)).toBe(2);
    expect(prizeRankOf(20, ladder)).toBe(3);
    expect(prizeRankOf(10, ladder)).toBe(4);
    expect(prizeRankOf(5, ladder)).toBe(5);
  });

  it('celebrates exactly the top three and nothing under them', () => {
    expect(isTopPrize(prizeRankOf(130, ladder))).toBe(true);
    expect(isTopPrize(prizeRankOf(30, ladder))).toBe(true);
    expect(isTopPrize(prizeRankOf(20, ladder))).toBe(true);
    expect(isTopPrize(prizeRankOf(10, ladder))).toBe(false);
    expect(isTopPrize(prizeRankOf(5, ladder))).toBe(false);
  });

  it('puts every holder of the same amount on the same rung', () => {
    const shared = buildPrizeLadder([50, 50, 50, 20]);
    expect(prizeRankOf(50, shared)).toBe(1);
    expect(prizeRankOf(20, shared)).toBe(2);
  });

  it('ranks an amount that is not itself on the ladder by what beats it', () => {
    expect(prizeRankOf(25, ladder)).toBe(3); // 130 and 30 are larger
  });

  it('ranks a prize below a truncated top slice past the end of it', () => {
    // The callers read the top 200 rows; anything under the slice must come
    // back outside the top three rather than accidentally inside it.
    const slice = buildPrizeLadder([130, 30, 20]);
    expect(isTopPrize(prizeRankOf(1, slice))).toBe(false);
  });

  it('returns 0 for an unknown rank rather than guessing 1', () => {
    // Dan explicitly ruled out interrupting play for a routine head. A guessed
    // top rank on an empty ladder would do exactly that.
    expect(prizeRankOf(130, [])).toBe(0);
    expect(isTopPrize(prizeRankOf(130, []))).toBe(false);
  });

  it('returns 0 for an amount that is missing or worthless', () => {
    expect(prizeRankOf(undefined, ladder)).toBe(0);
    expect(prizeRankOf(0, ladder)).toBe(0);
    expect(prizeRankOf(-1, ladder)).toBe(0);
    expect(prizeRankOf('nonsense', ladder)).toBe(0);
  });

  it('works in cents, which is the unit the chest inventory is stored in', () => {
    const chests = buildPrizeLadder([1_300_000, 300_000, 200_000, 100_000]);
    expect(prizeRankOf(1_300_000, chests)).toBe(1);
    expect(prizeRankOf(200_000, chests)).toBe(3);
    expect(isTopPrize(prizeRankOf(100_000, chests))).toBe(false);
  });
});

describe('isMysteryCollectMode', () => {
  /**
   * Read from the live fn_collect_bounty body, 2026-08-26:
   *
   *   v_mode := CASE WHEN COALESCE(v_t.is_pko,false)            THEN 'pko'
   *                  WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
   *                  ELSE 'regular' END;
   */
  it('accepts the value production actually sends', () => {
    expect(isMysteryCollectMode('mystery_pre')).toBe(true);
  });

  it('accepts the bare name too, so a future rename lands already handled', () => {
    expect(isMysteryCollectMode('mystery')).toBe(true);
  });

  it('rejects the other two modes the function can return', () => {
    expect(isMysteryCollectMode('pko')).toBe(false);
    expect(isMysteryCollectMode('regular')).toBe(false);
  });

  it('rejects a missing mode instead of throwing', () => {
    expect(isMysteryCollectMode(undefined)).toBe(false);
    expect(isMysteryCollectMode(null)).toBe(false);
    expect(isMysteryCollectMode('')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isMysteryCollectMode('MYSTERY_PRE')).toBe(true);
  });

  it('lists both names and nothing else', () => {
    expect([...MYSTERY_COLLECT_MODES].sort()).toEqual(['mystery', 'mystery_pre']);
  });
});

describe('isTopPrize', () => {
  it("is Dan's three, one-based", () => {
    expect(TOP_PRIZE_RANKS).toBe(3);
    expect(isTopPrize(1)).toBe(true);
    expect(isTopPrize(3)).toBe(true);
    expect(isTopPrize(4)).toBe(false);
    expect(isTopPrize(0)).toBe(false);
    expect(isTopPrize(-1)).toBe(false);
  });

  it('rejects a rank that never arrived', () => {
    expect(isTopPrize(undefined)).toBe(false);
    expect(isTopPrize(NaN)).toBe(false);
  });
});
