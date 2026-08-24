/**
 * The client's hole-card count must agree with the engine's.
 *
 * This module is a deliberate COPY of a map that lives, unexported, inside a
 * method in `server/src/engine/ServerTableEngineDealing.ts`. The client cannot
 * import it - `server/` is a separate build that must not reach the browser
 * bundle - so the number exists in two places, and two places is how numbers
 * drift.
 *
 * These tests are what stops the drift. If the engine adds a variant or changes
 * a count, this file is where it surfaces.
 */

import { describe, it, expect } from 'vitest';
import { holeCardCountFor, DEFAULT_HOLE_CARDS } from '../../src/lib/holeCardCount';

describe('holeCardCountFor', () => {
  it('matches the engine map exactly', () => {
    // Transcribed from ServerTableEngineDealing.ts CARDS_PER_PLAYER. Keep the
    // two in step; this is the only place that checks.
    expect(holeCardCountFor('plo4')).toBe(4);
    expect(holeCardCountFor('plo5')).toBe(5);
    expect(holeCardCountFor('plo6')).toBe(6);
    expect(holeCardCountFor('plo8')).toBe(4);
    // 2026-08-23: Fixed Limit Omaha Hi-Lo. Four cards like every other Omaha —
    // the LIMIT in the name is the betting, not the deal. Its spelling contains
    // no "plo", which is how it slipped past five substring tests in the engine
    // and got dealt two cards; see server/src/engine/VariantRules.ts.
    expect(holeCardCountFor('flo8')).toBe(4);
    expect(holeCardCountFor('pineapple')).toBe(3);
  });

  it('falls back to two for Holdem, Short Deck and the unknown', () => {
    // The engine's own fallback. Short Deck changes the DECK, not the hand.
    expect(holeCardCountFor('nlh')).toBe(DEFAULT_HOLE_CARDS);
    expect(holeCardCountFor('short_deck')).toBe(DEFAULT_HOLE_CARDS);
    // Fixed Limit Hold'em is Hold'em: two cards, fixed betting.
    expect(holeCardCountFor('flh')).toBe(DEFAULT_HOLE_CARDS);
    expect(holeCardCountFor('a_variant_invented_next_year')).toBe(DEFAULT_HOLE_CARDS);
  });

  it('accepts the uppercase spelling the client actually holds', () => {
    // tableState.gameType is 'PLO4'; the database column is 'plo4'. That seam is
    // why this function lowercases, and why a case-sensitive lookup would have
    // silently returned 2 on every Omaha table - the exact bug, restored.
    expect(holeCardCountFor('PLO4')).toBe(4);
    expect(holeCardCountFor('PLO6')).toBe(6);
    expect(holeCardCountFor('Pineapple')).toBe(3);
  });

  it('never returns a count a seat cannot draw', () => {
    // SeatSlot clamps to 1..6, but the source should not be handing it nonsense
    // in the first place.
    for (const v of ['plo4', 'plo5', 'plo6', 'plo8', 'pineapple', 'nlh', '', null, undefined]) {
      const n = holeCardCountFor(v as string | null | undefined);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
    }
  });

  it('treats missing input as Holdem rather than throwing', () => {
    // A seat mid-join has no variant yet. Drawing two backs is a better outcome
    // than an exception inside a render.
    expect(holeCardCountFor(null)).toBe(DEFAULT_HOLE_CARDS);
    expect(holeCardCountFor(undefined)).toBe(DEFAULT_HOLE_CARDS);
    expect(holeCardCountFor('')).toBe(DEFAULT_HOLE_CARDS);
  });
});
