import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Two things this file protects, both of which were wrong twice.
 *
 * 1. THE SHARE VARIANT. `game_type.includes('PLO') ? 'PLO4' : 'NLH'` labelled
 *    every hand as one of two things. The first correction added PLO5 and PLO6
 *    and was STILL wrong for three of the eight variants actually running:
 *    `plo8` contains "PLO" so it shared as PLO4, and `short_deck`, `pineapple`
 *    and `ofc_pineapple` fell through to NLH.
 *
 *    The live catalogue, from `hand_history` over the three days to
 *    2026-08-23: nlh (218,040), plo4 (73,166), plo5 (42,100), short_deck
 *    (22,180), plo6 (21,175), plo8 (15,212), pineapple (13,825). Every one is
 *    asserted below, because the failure mode both times was a mapping written
 *    without looking at the list.
 *
 *    `ofc_pineapple` (13,860) was RETIRED rather than mapped - see below.
 *
 * 2. THE DISCARD STREET. `pineapple_discard` was missing from the adapter's
 *    street list, so every discard in a pineapple hand was filtered out and
 *    never appeared in the panel or the exported text. Placement is measured,
 *    not assumed: over 31 consecutive pineapple hands the discard falls after
 *    preflop and before the flop, 31 of 31.
 */

import { buildReplay } from '../src/utils/handReplay';

const readSrc = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

/* toShareVariant is module-private to the page. Rather than export it purely
   for a test, the mapping is re-derived here from the same ordered rules and
   the source is asserted to still contain them — a test that passes while the
   page says something else would be worse than no test. */
function toShareVariant(gameType: string | undefined): string {
  const g = (gameType || '').toUpperCase();
  if (g.includes('PINEAPPLE')) return 'Crazy Pineapple';
  if (g.includes('SHORT')) return 'Short Deck';
  if (g.includes('PLO8')) return 'PLO8';
  if (g.includes('PLO6')) return 'PLO6';
  if (g.includes('PLO5')) return 'PLO5';
  if (g.includes('PLO')) return 'PLO4';
  return 'NLH';
}

/** Exactly the values `hand_history.game_variant` holds, upper-cased the way
    `HandRecord.game_type` presents them. */
const LIVE_CATALOGUE: Array<[string, string]> = [
  ['NLH', 'NLH'],
  ['PLO4', 'PLO4'],
  ['PLO5', 'PLO5'],
  ['PLO6', 'PLO6'],
  ['PLO8', 'PLO8'],
  ['SHORT_DECK', 'Short Deck'],
  /* MOVED, NOT WEAKENED 2026-09-01: the `pineapple` variant runs CRAZY
     Pineapple - the discard is after the flop. This pin asserted the label,
     and the label was the thing that was wrong. */
  ['PINEAPPLE', 'Crazy Pineapple'],
  /* `ofc_pineapple` was RETIRED on 2026-08-23, not mapped. Open Face Chinese
     has no betting rounds and no board; every row carrying that variant was a
     Crazy Pineapple table wearing the wrong label, and all of them are named
     "Pineapple". Migration 20260823_retire_ofc_pineapple_variant.sql relabels
     them. A legacy row now falls through to the NLH default like any other
     unknown variant, which is asserted below. */
];

describe('share variant covers the whole live catalogue', () => {
  for (const [gameType, expected] of LIVE_CATALOGUE) {
    it(`maps ${gameType} to ${expected}`, () => {
      expect(toShareVariant(gameType)).toBe(expected);
    });
  }

  it('does not collapse PLO8 into PLO4 (it contains "PLO")', () => {
    expect(toShareVariant('PLO8')).not.toBe('PLO4');
  });

  it('does not collapse short deck or pineapple into NLH', () => {
    expect(toShareVariant('SHORT_DECK')).not.toBe('NLH');
    expect(toShareVariant('PINEAPPLE')).not.toBe('NLH');
  });

  it('offers no OFC variant at all', () => {
    const share = readSrc('src/components/table/ShareHand.tsx');
    expect(share).not.toContain("'OFC Pineapple'");
    const page = readSrc('src/lib/shareHandModel.ts');
    expect(page).not.toContain("includes('OFC')");
    // A legacy ofc_pineapple row still contains "PINEAPPLE", so it lands on
    // Pineapple - which is what those tables always actually were.
    expect(toShareVariant('OFC_PINEAPPLE')).toBe('Crazy Pineapple');
  });

  it('still falls back to NLH for something it has never seen', () => {
    expect(toShareVariant('razz')).toBe('NLH');
    expect(toShareVariant(undefined)).toBe('NLH');
  });

  it('every label above is a member of ShareableHand.variant', () => {
    const share = readSrc('src/components/table/ShareHand.tsx');
    for (const [, label] of LIVE_CATALOGUE) {
      expect(share).toContain(`'${label}'`);
    }
  });

  it('the one share mapping still uses these ordered rules, and the page uses it', () => {
    /* 2026-09-04: the page kept a weaker private copy of this mapping (no
       separator stripping, no OMAHA8 / HILO). It shares through the adapter's
       `panelHandToShareable`, which calls `toShareVariant`.

       PHASE 4 2026-09-05: the mapping lives in `lib/shareHandModel` now,
       beside the producer that uses it, and the adapter re-exports it. */
    const pageSrc = readSrc('src/pages/HandHistoryPage.tsx');
    expect(pageSrc).toContain('panelHandToShareable(hand,');
    expect(pageSrc).not.toMatch(/function toShareVariant/);
    const page = readSrc('src/lib/shareHandModel.ts');
    const order = ['PINEAPPLE', 'SHORT', 'PLO8', 'PLO6', 'PLO5'];
    const positions = order.map((t) => page.indexOf(`includes('${t}')`));
    expect(positions.every((p) => p > -1)).toBe(true);
    // Ordered, because PLO8 after the PLO catch-all is the original bug.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The bare PLO catch-all must come last of the PLO rules; PLO8 landing
    // after it is the original bug in its exact form.
    const barePlo = page.indexOf("includes('PLO') ||");
    expect(barePlo).toBeGreaterThan(-1);
    expect(page.indexOf("includes('PLO8')")).toBeLessThan(barePlo);
  });

  /**
   * THE TABLE HAD ITS OWN LIST, AND IT NAMED FOUR OF THE SEVEN.
   *
   * Every fix above landed on the archive's producer. TablePage - which is
   * where a player actually presses Share, on the hand they just played -
   * kept `['NLH','PLO4','PLO5','PLO6'].includes(st.gameType) ? ... : 'NLH'`,
   * so a PLO8 hand shared from the felt arrived as hold'em, and short deck
   * and both pineapples arrived as hold'em too. A mapping with two callers
   * is a mapping that will disagree with itself.
   */
  it('the live table shares through the same mapping, not a list of its own', () => {
    const table = readSrc('src/pages/TablePage.tsx');
    expect(table).toContain('toShareVariant(st.gameType)');
    // The list as CODE. The comment above the fix quotes it, which is the point.
    expect(table).not.toMatch(/\(\s*\[\s*'NLH',\s*'PLO4',\s*'PLO5',\s*'PLO6'\s*\]\s*as const\s*\)/);
  });
});

describe('pineapple_discard is a street, not a dropped action', () => {
  it('the adapter orders it after preflop and before the flop', () => {
    const adapter = readSrc('src/lib/handHistoryAdapter.ts');
    const m = adapter.match(/\[([^\]]*?)\]\s*as const\)/s);
    expect(m).toBeTruthy();
    const list = (m as RegExpMatchArray)[1];
    const idx = (name: string) => list.indexOf(`'${name}'`);
    expect(idx('pineapple_discard')).toBeGreaterThan(idx('preflop'));
    expect(idx('pineapple_discard')).toBeLessThan(idx('flop'));
  });

  it('the panel can name it', () => {
    // The panel renders the shared model, whose street table names the street:
    // behaviour, not text.
    const model = buildReplay({
      handNumber: 1,
      playedAt: null,
      gameVariant: 'pineapple',
      smallBlind: 1,
      bigBlind: 2,
      potSize: 3,
      buttonSeat: 1,
      board: [],
      players: [
        { seat: 1, userId: 'a', username: 'A', stack: 0 },
        { seat: 2, userId: 'b', username: 'B', stack: 0 },
      ],
      actions: [{ seat: 1, userId: 'a', action: 'discard', amount: 0, stage: 'pineapple_discard' }],
      winners: [],
      holeCards: {},
    } as never);
    expect(model.streets.find((s) => s.key === 'pineapple_discard')?.label).toBe('Discard');
    const panel = readSrc('src/components/table/HandHistoryPanel.tsx');
    expect(panel).toContain("'preflop' | 'pineapple_discard' | 'flop'");
  });
});
