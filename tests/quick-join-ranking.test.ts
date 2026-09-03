/**
 * Quick Join must offer FAVOURITES first, then games similar to the one being
 * played, before anything else.
 *
 * Dan 2026-08-23: "'quick join' should be users favorite games, or similar
 * games to the one they are playing."
 *
 * Before this, `MultiTablePage.handleAddTable` sorted the club's open tables by
 * an exact string compare on the stakes LABEL, then by seat count. Three things
 * that sort gets wrong are pinned below, because each one was reachable from
 * the sheet in production:
 *
 *   - favourites were never read, so the game a player had explicitly starred
 *     could sit below a table they had never opened;
 *   - variant was never compared, so a PLO player was offered Hold'em at their
 *     stake ahead of PLO one rung up;
 *   - "0.5/1" and "0.50/1.00" are the same game and never matched as strings.
 */

import { describe, it, expect } from 'vitest';
import {
  rankQuickJoinTables,
  isSameVariant,
  bigBlindFromStakesLabel,
  variantKey,
  stakeLadderFor,
  rungOffset,
  type QuickJoinCandidate,
} from '../src/lib/quickJoinRanking';

const table = (over: Partial<QuickJoinCandidate> & { id: string }): QuickJoinCandidate => ({
  name: over.id,
  variant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  players: 4,
  maxPlayers: 9,
  ...over,
});

/** The table the player is sitting at in most of these cases: PLO, 1/2. */
const playingPlo12 = { id: 'seated', variant: 'plo', bigBlind: 2 };

describe('variant comparison', () => {
  it('treats every alias of one game as the same game', () => {
    // The aliases live in gameCode.VARIANT_CODES, which this delegates to
    // rather than copying — that is the point of the delegation.
    expect(isSameVariant('nlh', 'holdem')).toBe(true);
    expect(isSameVariant('nlhe', 'texas_holdem')).toBe(true);
    expect(isSameVariant('plo', 'omaha')).toBe(true);
    expect(isSameVariant('plo', 'plo4')).toBe(true);
    expect(isSameVariant('short_deck', 'six_plus')).toBe(true);
  });

  it('keeps genuinely different games apart', () => {
    expect(isSameVariant('plo', 'plo5')).toBe(false);
    expect(isSameVariant('nlh', 'plo')).toBe(false);
    expect(isSameVariant('plo5', 'plo6')).toBe(false);
  });

  it('never claims two unidentifiable variants are the same game', () => {
    // Two rows the mapper could not read are not evidence of a match.
    expect(variantKey(null)).toBe('UNKNOWN');
    expect(isSameVariant(null, undefined)).toBe(false);
    expect(isSameVariant('', '')).toBe(false);
  });
});

describe('the stakes ladder', () => {
  /**
   * Dan 2026-08-26: "ALSO SHOW ANY GAMES THAT ARE ONE STAKES LEVEL LOWER, AND
   * ONE HIGHER."
   *
   * The rungs are the ones the CLUB is running, taken from the candidate set,
   * not from a canonical ladder constant. The blinds below are Midway's real
   * PLO ladder as it stood on the day this was written.
   */
  const midwayPlo = [
    { id: 'a', name: 'a', variant: 'plo', bigBlind: 0.5 },
    { id: 'b', name: 'b', variant: 'plo', bigBlind: 1 },
    { id: 'c', name: 'c', variant: 'plo', bigBlind: 2 },
    { id: 'd', name: 'd', variant: 'plo', bigBlind: 4 },
    { id: 'e', name: 'e', variant: 'plo', bigBlind: 10 },
    { id: 'x', name: 'x', variant: 'nlh', bigBlind: 3 }, // a different game
  ];

  it('is built from the rungs this club actually runs, for this game only', () => {
    // 3 is a Hold'em blind here, so it is NOT a rung on the PLO ladder — that
    // is the whole reason the ladder is per variant.
    expect(stakeLadderFor(midwayPlo, 'plo', 2)).toEqual([0.5, 1, 2, 4, 10]);
  });

  it('always contains the stake the player is sitting at, even if unique', () => {
    expect(stakeLadderFor(midwayPlo, 'plo', 7)).toEqual([0.5, 1, 2, 4, 7, 10]);
  });

  it('counts one level lower and one level higher, whatever the ratio', () => {
    const ladder = stakeLadderFor(midwayPlo, 'plo', 2);
    expect(rungOffset(ladder, 2, 1)).toBe(-1); // 1/2 down to 0.50/1
    expect(rungOffset(ladder, 2, 4)).toBe(1); // 1/2 up to 2/4
    expect(rungOffset(ladder, 2, 2)).toBe(0);
    // 5/10 is TWO rungs up from 1/2 on this ladder. The old 2.5x ratio band
    // called it near; a ladder does not.
    expect(rungOffset(ladder, 2, 10)).toBe(2);
  });

  it('is symmetric', () => {
    const ladder = stakeLadderFor(midwayPlo, 'plo', 2);
    expect(rungOffset(ladder, 4, 2)).toBe(-1);
    expect(rungOffset(ladder, 2, 4)).toBe(1);
  });

  it('treats missing or nonsense stakes as off the ladder, never as the same rung', () => {
    const ladder = stakeLadderFor(midwayPlo, 'plo', 2);
    expect(rungOffset(ladder, null, 2)).toBeNull();
    expect(rungOffset(ladder, 0, 2)).toBeNull();
    expect(rungOffset(ladder, Number.NaN, 2)).toBeNull();
    expect(rungOffset(ladder, 2, 99)).toBeNull(); // not a rung here
  });

  it('matches rungs at whatever precision the row carries', () => {
    // 0.50 and 0.5 are one rung, not two: the ladder is keyed on the value.
    const rows = [
      { id: 'p', name: 'p', variant: 'plo', bigBlind: 0.5 },
      { id: 'q', name: 'q', variant: 'plo', bigBlind: 0.5 },
    ];
    expect(stakeLadderFor(rows, 'plo', 0.5)).toEqual([0.5]);
  });

  it('reads a FIXED LIMIT label off the front, where its big blind lives', () => {
    /* stakesLabel renders a limit game as its BET SIZES, `bb/bb*2`, because
       that is what a limit player reads. So "2/4" fixed limit has a big blind
       of 2 -- the FIRST number -- while "1/2" no-limit has a big blind of 2,
       the SECOND. Reading index 1 unconditionally doubled every limit table's
       stake and pushed it up its own ladder, mis-tiering the whole sheet. */
    expect(bigBlindFromStakesLabel('2/4', 'flh')).toBe(2);
    expect(bigBlindFromStakesLabel('2/4', 'nlh')).toBe(4);
    expect(bigBlindFromStakesLabel('10/20', 'flo8')).toBe(10);
    // An unknown or absent variant keeps the no-limit reading, which is the
    // overwhelming majority of tables and the previous behaviour.
    expect(bigBlindFromStakesLabel('1/2')).toBe(2);
    expect(bigBlindFromStakesLabel('1/2', null)).toBe(2);
  });

  it('reads the big blind out of a stakes label whatever its precision', () => {
    // The multi-table tab stores stakes only as this string, and this is the
    // parse that replaces the old label-equality compare.
    expect(bigBlindFromStakesLabel('0.50/1.00')).toBe(1);
    expect(bigBlindFromStakesLabel('0.5/1')).toBe(1);
    expect(bigBlindFromStakesLabel('1/2')).toBe(2);
    expect(bigBlindFromStakesLabel('')).toBeNull();
    expect(bigBlindFromStakesLabel('NLH')).toBeNull();
    expect(bigBlindFromStakesLabel(undefined)).toBeNull();
  });
});

describe('rankQuickJoinTables', () => {
  it('puts favourites first, ahead of a same-variant same-stakes table', () => {
    const rows = rankQuickJoinTables(
      [
        table({ id: 'perfect-match', variant: 'plo', bigBlind: 2, players: 8 }),
        table({ id: 'starred', variant: 'nlh', bigBlind: 10, players: 2 }),
      ],
      { favoriteTableIds: ['starred'], currentTable: playingPlo12 }
    );

    expect(rows.map((r) => r.id)).toEqual(['starred', 'perfect-match']);
    expect(rows[0].tier).toBe('favorite');
    expect(rows[0].reason).toBe('Favourite');
  });

  it('ranks the same game at a near stake above a different game at the same stake', () => {
    // The headline regression: a PLO player was offered Hold'em at 1/2 above
    // PLO at 2/5, because only the stakes label was ever compared.
    const rows = rankQuickJoinTables(
      [
        table({ id: 'holdem-same-stake', variant: 'nlh', bigBlind: 2, players: 8 }),
        table({ id: 'plo-one-rung-up', variant: 'plo', bigBlind: 5, players: 3 }),
      ],
      { currentTable: playingPlo12 }
    );

    expect(rows.map((r) => r.id)).toEqual(['plo-one-rung-up', 'holdem-same-stake']);
    expect(rows[0].tier).toBe('adjacent');
    expect(rows[1].tier).toBe('other');
  });

  it('puts the SAME stakes above one rung away (Dan 2026-08-26)', () => {
    // "FIND ANY OTHER 1/2 PLO GAMES, BUT ALSO SHOW ANY GAMES THAT ARE ONE
    //  STAKES LEVEL LOWER, AND ONE HIGHER." Exact first, then the neighbours,
    // and the neighbours say which way they are.
    const rows = rankQuickJoinTables(
      [
        table({ id: 'one-up', variant: 'plo', bigBlind: 4, players: 9, maxPlayers: 9 }),
        table({ id: 'one-down', variant: 'plo', bigBlind: 1, players: 9, maxPlayers: 9 }),
        table({ id: 'exact-match', variant: 'plo', bigBlind: 2, players: 3, maxPlayers: 9 }),
      ],
      { currentTable: playingPlo12 }
    );

    expect(rows.map((r) => r.id)).toEqual(['exact-match', 'one-down', 'one-up']);
    expect(rows.map((r) => r.tier)).toEqual(['exact', 'adjacent', 'adjacent']);
    expect(rows.map((r) => r.reason)).toEqual(['Same Stakes', 'One Level Down', 'One Level Up']);
  });

  it('orders the full tier ladder: favourite, same stakes, one level away, same game, the rest', () => {
    const rows = rankQuickJoinTables(
      [
        table({ id: 'other', variant: 'nlh', bigBlind: 2 }),
        table({ id: 'same-game-far-stake', variant: 'plo', bigBlind: 25 }),
        table({ id: 'one-level', variant: 'omaha', bigBlind: 5 }),
        table({ id: 'exact', variant: 'plo', bigBlind: 2 }),
        table({ id: 'fav', variant: 'plo6', bigBlind: 100 }),
      ],
      { favoriteTableIds: ['fav'], currentTable: playingPlo12 }
    );

    expect(rows.map((r) => r.id)).toEqual([
      'fav',
      'exact',
      'one-level',
      'same-game-far-stake',
      'other',
    ]);
    expect(rows.map((r) => r.tier)).toEqual([
      'favorite',
      'exact',
      'adjacent',
      'same-game',
      'other',
    ]);
  });

  it('matches stakes numerically, so 0.50/1.00 and 0.5/1 are one game', () => {
    // Identical rows apart from the precision the row happens to carry: both
    // must land in the same tier. The old string compare matched neither.
    const rows = rankQuickJoinTables(
      [
        table({ id: 'padded', variant: 'plo', smallBlind: 0.5, bigBlind: 1.0, players: 6 }),
        table({ id: 'terse', variant: 'plo', smallBlind: 0.5, bigBlind: 1, players: 6 }),
      ],
      { currentTable: { id: 'seated', variant: 'plo', bigBlind: 1 } }
    );

    expect(rows.every((r) => r.tier === 'exact')).toBe(true);
  });

  describe('tie-breaking inside a tier', () => {
    it('prefers a table with a seat over a full one', () => {
      const rows = rankQuickJoinTables(
        [
          table({ id: 'full', variant: 'plo', bigBlind: 2, players: 9, maxPlayers: 9 }),
          table({ id: 'has-seat', variant: 'plo', bigBlind: 2, players: 6, maxPlayers: 9 }),
        ],
        { currentTable: playingPlo12 }
      );

      expect(rows.map((r) => r.id)).toEqual(['has-seat', 'full']);
      expect(rows[0].seatsOpen).toBe(3);
      expect(rows[1].seatsOpen).toBe(0);
    });

    it('prefers the busier table, because a two-hander is a wait not a game', () => {
      const rows = rankQuickJoinTables(
        [
          table({ id: 'quiet', variant: 'plo', bigBlind: 2, players: 2 }),
          table({ id: 'busy', variant: 'plo', bigBlind: 2, players: 7 }),
        ],
        { currentTable: playingPlo12 }
      );

      expect(rows.map((r) => r.id)).toEqual(['busy', 'quiet']);
    });

    it('prefers the closer stake when seat counts are equal', () => {
      // Both of these are the same game two or more rungs away, so they share
      // the 'same-game' tier and only the distance separates them. Picking two
      // rows from ONE tier is the point: a tier difference would decide this
      // before the tie-breaker was ever consulted.
      const rows = rankQuickJoinTables(
        [
          table({ id: 'three-rungs', variant: 'plo', bigBlind: 50, players: 5 }),
          table({ id: 'two-rungs', variant: 'plo', bigBlind: 10, players: 5 }),
          table({ id: 'one-rung', variant: 'plo', bigBlind: 5, players: 5 }),
        ],
        { currentTable: { id: 'seated', variant: 'plo', bigBlind: 2 } }
      );

      expect(rows.map((r) => r.tier)).toEqual(['adjacent', 'same-game', 'same-game']);
      expect(rows.map((r) => r.id)).toEqual(['one-rung', 'two-rungs', 'three-rungs']);
    });
  });

  describe('exclusions', () => {
    it('never offers a table that is already open in another tab', () => {
      const rows = rankQuickJoinTables([table({ id: 'already-open' }), table({ id: 'fresh' })], {
        excludeIds: ['already-open'],
      });

      expect(rows.map((r) => r.id)).toEqual(['fresh']);
    });

    it('never offers the table the player is sitting at, even unexcluded', () => {
      const rows = rankQuickJoinTables([table({ id: 'seated' }), table({ id: 'fresh' })], {
        currentTable: playingPlo12,
      });

      expect(rows.map((r) => r.id)).toEqual(['fresh']);
    });

    it('honours the row limit the sheet can show', () => {
      const many = Array.from({ length: 12 }, (_, i) => table({ id: `t${i}`, players: 12 - i }));
      expect(rankQuickJoinTables(many, {})).toHaveLength(5);
      expect(rankQuickJoinTables(many, { limit: 3 })).toHaveLength(3);
    });
  });

  describe('a player with no favourites and no current table', () => {
    it('still gets a sane list rather than an empty or arbitrary one', () => {
      const rows = rankQuickJoinTables([
        table({ id: 'empty-table', players: 0, maxPlayers: 9 }),
        table({ id: 'full-table', players: 6, maxPlayers: 6 }),
        table({ id: 'good-game', players: 5, maxPlayers: 9 }),
      ]);

      // Joinable before full, then busiest first. Nothing is dropped.
      expect(rows.map((r) => r.id)).toEqual(['good-game', 'empty-table', 'full-table']);
      expect(rows.every((r) => r.tier === 'other')).toBe(true);
    });

    it('is deterministic: identical input in a different order gives one answer', () => {
      // Without the name/id last resort the sheet reshuffles between two
      // fetches that returned the same rows in a different order, which reads
      // as the list flickering under the player's thumb.
      const a = table({ id: 'a', name: 'Alpha', players: 5 });
      const b = table({ id: 'b', name: 'Bravo', players: 5 });
      const c = table({ id: 'c', name: 'Charlie', players: 5 });

      expect(rankQuickJoinTables([c, a, b]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
      expect(rankQuickJoinTables([b, c, a]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('survives an empty club with no rows at all', () => {
      expect(rankQuickJoinTables([])).toEqual([]);
      expect(rankQuickJoinTables([], { favoriteTableIds: ['x'] })).toEqual([]);
    });
  });

  it('labels every row with a Title Case reason and no em dash (house rule)', () => {
    const rows = rankQuickJoinTables(
      [
        table({ id: 'fav', variant: 'plo', bigBlind: 2 }),
        table({ id: 'adjacent', variant: 'plo', bigBlind: 5 }),
        table({ id: 'same', variant: 'plo', bigBlind: 50 }),
        table({ id: 'other', variant: 'nlh', bigBlind: 2 }),
      ],
      { favoriteTableIds: ['fav'], currentTable: playingPlo12 }
    );

    expect(rows.map((r) => r.reason)).toEqual([
      'Favourite',
      'One Level Up',
      'Same Game',
      'Open Seats',
    ]);
    for (const r of rows) {
      expect(r.reason).not.toContain('—');
      for (const word of r.reason.split(' ')) {
        expect(word[0]).toBe(word[0].toUpperCase());
      }
    }
  });
});
