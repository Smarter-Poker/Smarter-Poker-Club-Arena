/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TOURNAMENT LOBBY TAB CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The seven tabs of the tournament lobby were written in parallel by seven
 * agents who could not see each other's work, and the 2026-08-26 audit found
 * exactly the defect that produces: four answers to the same question on four
 * tabs of one screen.
 *
 * `src/components/tournament/details/types.ts` is now the one place any of them
 * is answered, and this file pins each answer to the defect it replaced. Every
 * case below is a real thing that was on screen, not a hypothetical.
 */

import { describe, it, expect } from 'vitest';
import {
  chips,
  chipsCompact,
  clockText,
  effectivePrizePool,
  initials,
  isPlayerLive,
  isPlayerOut,
  normaliseTabId,
  ordinal,
  paidPlaceCount,
  parsePayoutStructure,
  placePrize,
} from '../../src/components/tournament/details/types';

/* ═══════════════════════════════════════════════════════════════════════════
   ORDINAL — the one that put "NaNth" on a screen
   ═══════════════════════════════════════════════════════════════════════════ */

describe('ordinal', () => {
  it('numbers a finish the way a player reads it', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(101)).toBe('101st');
  });

  it('groups a four figure finish, because a big field has one', () => {
    expect(ordinal(1000)).toBe('1,000th');
    expect(ordinal(1231)).toBe('1,231st');
  });

  it('NEVER renders NaN, null or zero as a position', () => {
    // `position` is nullable on the row and `any` through the index signature,
    // so every caller feeds this something that can be absent. Unguarded, the
    // old implementation produced the literal string "NaNth".
    expect(ordinal(Number.NaN)).toBe('-');
    expect(ordinal(null)).toBe('-');
    expect(ordinal(undefined)).toBe('-');
    expect(ordinal(0)).toBe('-');
    expect(ordinal(-4)).toBe('-');
    expect(ordinal(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PAYOUT STRUCTURE — one parser, because three of them disagreed
   ═══════════════════════════════════════════════════════════════════════════ */

describe('parsePayoutStructure', () => {
  it('reads the plain per-place shape', () => {
    const places = parsePayoutStructure([
      { place: 1, percentage: 50 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ]);
    expect(places).toEqual([
      { place: 1, percentage: 50 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ]);
  });

  it('reads the column when it arrives as a JSON string, which it does', () => {
    const places = parsePayoutStructure('[{"position":1,"percentage":65},{"rank":2,"pct":35}]');
    expect(places).toEqual([
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ]);
  });

  it('EXPANDS a range row into one entry per place', () => {
    // THE BUG. Detail's local parser returned the stored rows verbatim, so this
    // structure - which pays nine places - counted as TWO. That number went to
    // HandForHandBanner as `paidPositions`, putting the money bubble seven
    // places early, and the podium's `place === position` lookup found nothing
    // for 2nd or 3rd and drew a dash over a real prize.
    const raw = [
      { place: 1, percentage: 50 },
      { from: 2, to: 9, percentage: 6.25 },
    ];
    expect(paidPlaceCount(raw)).toBe(9);
    const places = parsePayoutStructure(raw);
    expect(places?.[8]).toEqual({ place: 9, percentage: 6.25 });
  });

  it('expands the other range spelling, a hyphenated place string', () => {
    expect(paidPlaceCount([{ place: '4-6', percentage: 5 }])).toBe(3);
  });

  it('returns null for a column that cannot be used, never an empty array', () => {
    // The caller has to be able to tell "no structure published" from "a
    // structure that pays nobody", because those are different sentences.
    expect(parsePayoutStructure(null)).toBeNull();
    expect(parsePayoutStructure('')).toBeNull();
    expect(parsePayoutStructure('not json at all')).toBeNull();
    expect(parsePayoutStructure([])).toBeNull();
    expect(parsePayoutStructure([{ place: 1, percentage: 0 }])).toBeNull();
    expect(paidPlaceCount(undefined)).toBe(0);
  });

  it('keeps the last write for a place named twice, and orders the field', () => {
    const places = parsePayoutStructure([
      { place: 3, percentage: 20 },
      { place: 1, percentage: 40 },
      { place: 1, percentage: 50 },
    ]);
    expect(places).toEqual([
      { place: 1, percentage: 50 },
      { place: 3, percentage: 20 },
    ]);
  });
});

describe('placePrize', () => {
  /* 2026-08-29: these pinned `Math.trunc(pool * pct) / 100` and a two-argument
     signature, and both were the bug. The lobby truncated where the engine
     rounds, and a function handed ONE percentage cannot express the rule the
     engine actually pays by -- the last paid place takes what is left, so the
     places sum to the pool. Measured that day: 13 of the 78 pool-and-structure
     combinations in production showed a player a different number from the one
     that reached their wallet. placePrize now takes the whole structure and
     defers to src/lib/payoutMath.ts, which is byte-identical to the engine's
     copy. Moved to the new mechanism in the same commit that shipped it. */
  const NINE = [30, 20, 15, 10, 8, 6, 5, 3.5, 2.5].map((percentage, i) => ({
    place: i + 1,
    percentage,
  }));
  const HEADS_UP = [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 50 },
  ];

  it('prices a place exactly as the engine pays it', () => {
    expect(placePrize(1000, HEADS_UP, 1)).toBe(500);
    expect(placePrize(1000, HEADS_UP, 2)).toBe(500);
    // The cent that used to differ: 3.5% of 513 is 17.955, and the lobby
    // showed 17.95 while the wallet received 17.96.
    expect(placePrize(513, NINE, 8)).toBe(17.96);
  });

  it('the places it shows add up to the pool, to the cent', () => {
    for (const pool of [513, 483, 1000, 0.19, 12345.67]) {
      const total = NINE.reduce((s, e) => s + Math.round(placePrize(pool, NINE, e.place) * 100), 0);
      expect(total, `pool ${pool}`).toBe(Math.round(pool * 100));
    }
  });

  it('pays nothing for a pool or a place that is not a number', () => {
    expect(placePrize(Number.NaN, HEADS_UP, 1)).toBe(0);
    expect(placePrize(1000, HEADS_UP, Number.NaN)).toBe(0);
    expect(placePrize(0, HEADS_UP, 1)).toBe(0);
    expect(placePrize(-100, HEADS_UP, 1)).toBe(0);
    expect(placePrize(1000, HEADS_UP, 99)).toBe(0);
    expect(placePrize(1000, [], 1)).toBe(0);
  });
});

describe('effectivePrizePool', () => {
  it('floors the collected pool at the guarantee', () => {
    // Detail's podium printed the RAW pool while Rewards printed this, so on a
    // guaranteed event with an overlay the two tabs quoted different money for
    // the same finish.
    expect(effectivePrizePool(400, 1000)).toBe(1000);
    expect(effectivePrizePool(1500, 1000)).toBe(1500);
  });

  it('is just the pool when there is no guarantee', () => {
    expect(effectivePrizePool(750, 0)).toBe(750);
    expect(effectivePrizePool(750, null)).toBe(750);
  });

  it('never returns NaN for a row with nothing in either column', () => {
    expect(effectivePrizePool(null, undefined)).toBe(0);
    expect(effectivePrizePool(Number.NaN, Number.NaN)).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   WHO IS STILL IN — four tabs, four answers, until now
   ═══════════════════════════════════════════════════════════════════════════ */

describe('isPlayerOut / isPlayerLive', () => {
  it('counts a WINNER as still in', () => {
    // Ranking and Tables did. Detail and Rewards did not, so "Remaining",
    // "Average Stack" and "Total Chips" could differ between two tabs of the
    // same screen by a whole player.
    expect(isPlayerLive({ status: 'winner' })).toBe(true);
    expect(isPlayerOut({ status: 'winner' })).toBe(false);
  });

  it('counts registered and playing as still in', () => {
    expect(isPlayerLive({ status: 'registered' })).toBe(true);
    expect(isPlayerLive({ status: 'playing' })).toBe(true);
  });

  it('counts eliminated and finished as out', () => {
    expect(isPlayerOut({ status: 'eliminated' })).toBe(true);
    expect(isPlayerOut({ status: 'finished' })).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE FORMATTERS — nothing here may put NaN or Infinity on a screen
   ═══════════════════════════════════════════════════════════════════════════ */

describe('chips and chipsCompact', () => {
  it('groups a stack and never uses padStart', () => {
    expect(chips(1234567)).toBe((1234567).toLocaleString());
    expect(chips(0)).toBe('0');
  });

  /* Inherited 2026-08-26 from the retired TournamentStandings, whose own spec
     pinned this: a tournament chip is a whole chip, and printing "10,000.00"
     reads as currency for a stack that cannot hold a fraction. */
  it('prints whole chips, never a two-decimal money figure', () => {
    expect(chips(10000)).toBe((10000).toLocaleString());
    expect(chips(10000)).not.toContain('.');
    expect(chips(10000.4)).toBe((10000).toLocaleString());
  });

  it('survives every shape a nullable any-typed column can hold', () => {
    expect(chips(null)).toBe('0');
    expect(chips(undefined)).toBe('0');
    expect(chips(Number.NaN)).toBe('0');
    expect(chips(Number.POSITIVE_INFINITY)).toBe('0');
    expect(chipsCompact(null)).toBe('0');
    expect(chipsCompact(Number.NaN)).toBe('0');
  });

  /*
   * ROUNDED DOWN, AND NO TENTH ON A ROUND FIGURE (Dan 2026-09-08, verbatim:
   * "ONCE SOMETHING HITS OVER 1,000 USE 1K, IF ITS 1200 USE 1.2K, IF ITS
   * 10,000 USE 10K").
   *
   * This pinned 1,250 -> "1.3K", which ROUNDS UP - it tells a player they hold
   * more than they do - and the same formatter printed a round 5,000 as
   * "5.0K", a decimal on a forward-facing page. Both were visible on the
   * tournament cards. `chipsCompact` now delegates to the platform's single
   * compact formatter (`utils/format.compactChips`), so the pin moves with the
   * behaviour, in the same commit.
   */
  it('shortens a big stack without losing the sense of it', () => {
    expect(chipsCompact(1250)).toBe('1.2K');
    expect(chipsCompact(5000)).toBe('5K');
    expect(chipsCompact(447000)).toBe('447K');
    expect(chipsCompact(2500000)).toBe('2.5M');
    expect(chipsCompact(999)).toBe('999');
  });
});

describe('clockText', () => {
  it('clamps a negative countdown to zero rather than counting backwards', () => {
    expect(clockText(-30)).toBe('0:00');
  });

  it('grows an hour digit only once there is an hour to show', () => {
    expect(clockText(59)).toBe('0:59');
    expect(clockText(605)).toBe('10:05');
    expect(clockText(3661)).toBe('1:01:01');
  });
});

describe('initials', () => {
  it('always returns something to draw in an empty avatar', () => {
    expect(initials('Dan')).toBe('DA');
    expect(initials('big_slick')).toBe('BS');
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   TAB IDS — a bookmark from before the rename must not open a blank page
   ═══════════════════════════════════════════════════════════════════════════ */

describe('normaliseTabId', () => {
  it('sends the retired ids to the tabs that absorbed them', () => {
    expect(normaliseTabId('chips')).toBe('ranking');
    expect(normaliseTabId('payouts')).toBe('rewards');
    expect(normaliseTabId('mystery')).toBe('rewards');
  });

  it('falls back to Detail rather than to nothing', () => {
    expect(normaliseTabId('')).toBe('detail');
    expect(normaliseTabId(null)).toBe('detail');
    expect(normaliseTabId('something-nobody-shipped')).toBe('detail');
  });

  it('accepts a real id in any case, with any stray whitespace', () => {
    expect(normaliseTabId('  RANKING ')).toBe('ranking');
  });
});
