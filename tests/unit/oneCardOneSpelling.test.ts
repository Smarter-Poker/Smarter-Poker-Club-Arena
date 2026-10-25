/**
 * ONE CARD, ONE SPELLING (Dan 2026-10-25).
 *
 * The engine spells suits as words, table_hole_cards and realtime as letters,
 * and some paths send '10' for a ten. Every card now passes one converter on
 * the way in, so the hero's row, the board and every "is this the same card?"
 * check agree. See docs/changelog/2026-10-25-one-card-one-spelling.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalCards, normalizeCard, normalizeCards } from '../../src/utils/tableGeometry';
import { cardKey } from '../../src/utils/handEvaluator';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('one card, one spelling', () => {
  it('every spelling of a card converts to the same short form', () => {
    for (const raw of [
      { rank: '10', suit: 'clubs' },
      { rank: 'T', suit: 'c' },
      { rank: 't', suit: 'CLUBS' },
      '10c',
      'Tclubs',
      'Tc',
    ]) {
      expect(normalizeCard(raw)).toEqual({ rank: 'T', suit: 'c' });
    }
  });

  it('the board and the hero row now speak the same language', () => {
    const board = normalizeCards([{ rank: '9', suit: 'clubs' }]);
    const hole = canonicalCards([{ rank: '9', suit: 'c' }]);
    expect(board).toEqual(hole);
  });

  it('canonicalCards never drops or moves a slot', () => {
    const facedown = { rank: '?', suit: '?' };
    const out = canonicalCards([{ rank: 'A', suit: 'spades' }, null, facedown]);
    expect(out).toEqual([{ rank: 'A', suit: 's' }, null, facedown]);
  });

  it('card matching ignores spelling', () => {
    expect(cardKey({ rank: '10', suit: 'clubs' } as any)).toBe(cardKey({ rank: 'T', suit: 'c' }));
  });

  it('every way cards enter the table goes through the converter', () => {
    const mapper = read('src/utils/mapEngineSnapshot.ts');
    expect(mapper).toContain('canonicalCards(p.cards)');
    expect(mapper).toContain('communityCards: canonicalCards(s.community_cards)');
    expect(mapper).toContain('communityCards2: canonicalCards(s.community_cards2)');
    expect(mapper).toContain('communityCards3: canonicalCards(s.community_cards3)');
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('let formattedCards = canonicalCards(rawCards || [])');
    expect(page).toContain('let parsedCards = canonicalCards(rawCards || [])');
    expect(page).toContain('canonicalCards(sp.cards) as Card[]');
    expect(page).toContain('canonicalCards(result.cards)');
    // The old letter-only conversion that left ranks untouched is gone.
    expect(page).not.toMatch(/suit:\s*ENGINE_SUIT_MAP\[c\.suit\]/);
  });
});
