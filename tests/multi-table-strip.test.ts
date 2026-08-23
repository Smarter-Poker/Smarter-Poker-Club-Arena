/**
 * The multi-table strip's two pure decisions, from Dan's 2026-08-21 notes:
 *
 *   1. "if i don't have a hand it should say the game type
 *       (NLH, PLO PLO5 PLO6 SPIN, MTT HU ETC)"      -> gameCode
 *   2. "you should be able to keep swiping in one direction... when you get
 *       to the end it should just restart at the first table" -> swipeTargetIndex
 *
 * Both used to be inline in a component (a memo and a touch handler), which
 * meant neither could be checked except by hand on a phone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gameCode, gameCodeFromName } from '../src/utils/gameCode';
import { swipeTargetIndex } from '../src/utils/swipeTarget';

describe('gameCode', () => {
  it('maps every live DB variant to the acronym players use', () => {
    // The exact game_variant values present in production today.
    expect(gameCode({ variant: 'nlh' })).toBe('NLH');
    expect(gameCode({ variant: 'plo4' })).toBe('PLO');
    expect(gameCode({ variant: 'plo5' })).toBe('PLO5');
    expect(gameCode({ variant: 'plo6' })).toBe('PLO6');
    expect(gameCode({ variant: 'plo8' })).toBe('PLO8');
    expect(gameCode({ variant: 'short_deck' })).toBe('SHORT');
    expect(gameCode({ variant: 'pineapple' })).toBe('PINE');
  });

  it('has retired OFC, which this platform never dealt', () => {
    /* Open Face Chinese is a card-PLACEMENT game: no betting rounds, no board.
       Every row that carried `ofc_pineapple` was a Crazy Pineapple table
       wearing the wrong label - all named "Pineapple", all with flop/turn/river
       streets - and the bare `ofc` variant was never used by a single row.
       Retired 2026-08-23 by migration
       20260823_retire_ofc_pineapple_variant.sql. A legacy row falls back to the
       generic path rather than naming a game nobody played. */
    // No CURATED code any more. A legacy row falls through the generic
    // unknown-variant path (strip, uppercase, truncate to 6) instead of being
    // given a real game's acronym.
    expect(gameCode({ variant: 'ofc_pineapple' })).toBe('OFCPIN');
    const src = readFileSync(resolve(__dirname, '../src/utils/gameCode.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*ofc(_pineapple)?:/m);
  });

  it('accepts the uppercase form tableState.gameType reports', () => {
    expect(gameCode({ variant: 'PLO5' })).toBe('PLO5');
    expect(gameCode({ variant: 'NLH' })).toBe('NLH');
  });

  it('a spin is a SPIN before it is NLH', () => {
    expect(
      gameCode({ variant: 'nlh', isTournament: true, tournamentFormat: 'spin', maxPlayers: 3 })
    ).toBe('SPIN');
  });

  it('tournament format outranks variant, and an unresolved tournament reads MTT', () => {
    expect(gameCode({ variant: 'plo5', isTournament: true, tournamentFormat: 'mtt' })).toBe('MTT');
    expect(gameCode({ variant: 'nlh', isTournament: true, tournamentFormat: 'sng' })).toBe('SNG');
    // Format not loaded yet - MTT is the honest majority guess, never blank.
    expect(gameCode({ variant: 'nlh', isTournament: true })).toBe('MTT');
  });

  it('a 2-seat CASH table is HU, but a 2-seat SNG stays SNG', () => {
    expect(gameCode({ variant: 'nlh', maxPlayers: 2 })).toBe('HU');
    expect(
      gameCode({ variant: 'nlh', isTournament: true, tournamentFormat: 'sng', maxPlayers: 2 })
    ).toBe('SNG');
  });

  it('normal ring sizes are never mistaken for heads-up', () => {
    for (const seats of [3, 6, 7, 8, 9]) {
      expect(gameCode({ variant: 'nlh', maxPlayers: seats })).toBe('NLH');
    }
  });

  it('returns empty (not a broken pill) when there is nothing to go on', () => {
    expect(gameCode({})).toBe('');
    expect(gameCode({ variant: '' })).toBe('');
    expect(gameCode({ variant: null })).toBe('');
  });

  it('shows an unknown variant rather than hiding it, kept pill-short', () => {
    const code = gameCode({ variant: 'razz_hi_lo_split_eight' });
    expect(code).toBe('RAZZHI');
    expect(code.length).toBeLessThanOrEqual(6);
  });
});

describe('gameCodeFromName (first-paint fallback)', () => {
  it('recovers the variant from the table names production actually writes', () => {
    expect(gameCodeFromName('NLH 0.05/0.10')).toBe('NLH');
    expect(gameCodeFromName('plo5 deep 1/2')).toBe('PLO5');
    expect(gameCodeFromName('Coffee Break Freeroll (plo4) - Table 1')).toBe('PLO');
    expect(gameCodeFromName('Sunday Spin')).toBe('SPIN');
  });

  it('is empty when the name carries no variant, so the real code can win', () => {
    expect(gameCodeFromName('Table 2')).toBe('');
    expect(gameCodeFromName('')).toBe('');
    expect(gameCodeFromName(undefined)).toBe('');
  });
});

describe('swipeTargetIndex — the strip is a ring', () => {
  const slow = { elapsedMs: 1000 }; // below the flick velocity: distance decides

  it('swiping LEFT past the last table restarts at the first', () => {
    expect(swipeTargetIndex({ activeIndex: 3, count: 4, offset: -120, ...slow })).toBe(0);
  });

  it('swiping RIGHT past the first table lands on the last', () => {
    expect(swipeTargetIndex({ activeIndex: 0, count: 4, offset: 120, ...slow })).toBe(3);
  });

  it('a player can keep swiping one way and cycle every table forever', () => {
    let idx = 0;
    const seen: number[] = [idx];
    for (let i = 0; i < 9; i++) {
      idx = swipeTargetIndex({ activeIndex: idx, count: 4, offset: -120, ...slow });
      seen.push(idx);
    }
    expect(seen).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
  });

  it('moves one table at a time in the middle of the strip', () => {
    expect(swipeTargetIndex({ activeIndex: 1, count: 4, offset: -120, ...slow })).toBe(2);
    expect(swipeTargetIndex({ activeIndex: 1, count: 4, offset: 120, ...slow })).toBe(0);
  });

  it('a short flick counts, a tap does not', () => {
    // 30px in 40ms = 0.75 px/ms - a deliberate flick.
    expect(swipeTargetIndex({ activeIndex: 0, count: 3, offset: -30, elapsedMs: 40 })).toBe(1);
    // 8px in 40ms clears the velocity gate but not the minimum distance.
    expect(swipeTargetIndex({ activeIndex: 0, count: 3, offset: -8, elapsedMs: 40 })).toBe(0);
    // A slow 30px drag is under the 50px threshold: stay put.
    expect(swipeTargetIndex({ activeIndex: 0, count: 3, offset: -30, ...slow })).toBe(0);
  });

  it('a single table (or none) cannot swipe anywhere', () => {
    expect(swipeTargetIndex({ activeIndex: 0, count: 1, offset: -400, ...slow })).toBe(0);
    expect(swipeTargetIndex({ activeIndex: 0, count: 0, offset: -400, ...slow })).toBe(0);
  });

  it('never returns an out-of-range index for any input', () => {
    for (const count of [1, 2, 3, 4]) {
      for (let active = 0; active < count; active++) {
        for (const offset of [-400, -120, -30, 0, 30, 120, 400]) {
          for (const elapsedMs of [10, 1000]) {
            const out = swipeTargetIndex({ activeIndex: active, count, offset, elapsedMs });
            expect(Number.isInteger(out)).toBe(true);
            expect(out).toBeGreaterThanOrEqual(0);
            expect(out).toBeLessThan(count);
          }
        }
      }
    }
  });
});
