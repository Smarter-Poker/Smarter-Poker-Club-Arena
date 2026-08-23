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
  isNearStakes,
  bigBlindFromStakesLabel,
  variantKey,
  STAKES_SIMILARITY_RATIO,
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

describe('stakes comparison', () => {
  it('accepts the neighbouring rungs of the stakes ladder', () => {
    expect(isNearStakes(2, 1)).toBe(true); // 1/2 next to 0.50/1
    expect(isNearStakes(2, 5)).toBe(true); // 1/2 next to 2/5
  });

  it('rejects a jump that is a different bankroll decision', () => {
    expect(isNearStakes(2, 10)).toBe(false); // 1/2 vs 5/10
    expect(isNearStakes(0.1, 2)).toBe(false);
  });

  it('is symmetric and honours the documented ratio exactly', () => {
    expect(isNearStakes(1, STAKES_SIMILARITY_RATIO)).toBe(true);
    expect(isNearStakes(STAKES_SIMILARITY_RATIO, 1)).toBe(true);
    expect(isNearStakes(1, STAKES_SIMILARITY_RATIO + 0.01)).toBe(false);
  });

  it('treats missing or nonsense stakes as not comparable rather than as zero', () => {
    expect(isNearStakes(null, 2)).toBe(false);
    expect(isNearStakes(0, 2)).toBe(false);
    expect(isNearStakes(Number.NaN, 2)).toBe(false);
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
    expect(rows[0].tier).toBe('similar');
    expect(rows[1].tier).toBe('other');
  });

  it('orders the full tier ladder: favourite, similar, same game, everything else', () => {
    const rows = rankQuickJoinTables(
      [
        table({ id: 'other', variant: 'nlh', bigBlind: 2 }),
        table({ id: 'same-game-far-stake', variant: 'plo', bigBlind: 25 }),
        table({ id: 'similar', variant: 'omaha', bigBlind: 5 }),
        table({ id: 'fav', variant: 'plo6', bigBlind: 100 }),
      ],
      { favoriteTableIds: ['fav'], currentTable: playingPlo12 }
    );

    expect(rows.map((r) => r.id)).toEqual(['fav', 'similar', 'same-game-far-stake', 'other']);
    expect(rows.map((r) => r.tier)).toEqual(['favorite', 'similar', 'same-game', 'other']);
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

    expect(rows.every((r) => r.tier === 'similar')).toBe(true);
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
      const rows = rankQuickJoinTables(
        [
          table({ id: 'two-rungs', variant: 'plo', bigBlind: 5, players: 5 }),
          table({ id: 'one-rung', variant: 'plo', bigBlind: 2, players: 5 }),
        ],
        { currentTable: { id: 'seated', variant: 'plo', bigBlind: 2 } }
      );

      expect(rows.map((r) => r.id)).toEqual(['one-rung', 'two-rungs']);
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
        table({ id: 'similar', variant: 'plo', bigBlind: 5 }),
        table({ id: 'same', variant: 'plo', bigBlind: 50 }),
        table({ id: 'other', variant: 'nlh', bigBlind: 2 }),
      ],
      { favoriteTableIds: ['fav'], currentTable: playingPlo12 }
    );

    expect(rows.map((r) => r.reason)).toEqual([
      'Favourite',
      'Similar Game',
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
