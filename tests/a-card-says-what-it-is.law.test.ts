/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A CARD SAYS WHAT IT IS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 7 of the Previous Hand build plan (2026-09-06).
 *
 * Every playing card on this platform is one component, `CardImage`, and its
 * alt text interpolated the RANK RAW: `` `${card.rank} Of ${SUIT_MAP[...]}` ``.
 * So a screen reader announced the ace of spades as **"A Of spades"** and the
 * ten of hearts as **"T Of hearts"** - on the felt, in the rundown, in the
 * replayer, on a shared hand, everywhere. A player who cannot see the cards
 * was being read the sprite's own field values.
 *
 * A FACE-DOWN CARD WAS WORSE: `CardBack` carried no alt, no role and no label
 * at all, so every muck, every opponent's holding and every undealt seat was
 * SILENT. A hand read as two cards short rather than as two cards you cannot
 * see, which is a different hand.
 *
 * WHAT THIS PINS, and each line is one of those defects:
 *
 *   1. `cardWords` is the ONE place a card becomes a sentence, and it spells
 *      the rank out.
 *   2. `CardImage`'s alt comes from it - not from a template of its own.
 *   3. `CardBack` names itself.
 *   4. Nothing is announced twice: the broken-image fallback and the felt's
 *      individually-labelled cards are hidden from the reader when something
 *      above them already says the same words.
 *   5. `preflopHoleLabel` keeps "Deuce". That is not an oversight to be
 *      unified away - "Pocket Deuces" is the poker room's phrase and "two of
 *      clubs" is the card's name. Two vocabularies, two sentences.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';
import { cardWords, cardsWords, FACE_DOWN_WORDS, RANK_WORD } from '../src/utils/cardWords';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('a card says what it is', () => {
  it('spells the rank, never the letter on the sprite', () => {
    expect(cardWords({ rank: 'A', suit: 's' })).toBe('Ace Of Spades');
    expect(cardWords({ rank: 'T', suit: 'h' })).toBe('Ten Of Hearts');
    expect(cardWords({ rank: '10', suit: 'h' })).toBe('Ten Of Hearts');
    expect(cardWords({ rank: 'K', suit: 'd' })).toBe('King Of Diamonds');
    expect(cardWords({ rank: 'Q', suit: 'c' })).toBe('Queen Of Clubs');
    expect(cardWords({ rank: '2', suit: 'c' })).toBe('Two Of Clubs');
    /* The three that were literally being read out before. */
    for (const said of ['A Of', 'T Of', 'K Of', 'Q Of', 'J Of']) {
      expect(cardWords({ rank: said[0], suit: 's' })).not.toContain(said);
    }
  });

  it('names every rank, so no card falls back to its letter', () => {
    for (const rank of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) {
      const words = cardWords({ rank, suit: 's' });
      expect(words, rank).toMatch(/^[A-Z][a-z]+ Of Spades$/);
    }
    expect(Object.keys(RANK_WORD)).toContain('10');
  });

  it('speaks a row of cards as one phrase', () => {
    expect(
      cardsWords([
        { rank: 'A', suit: 's' },
        { rank: 'K', suit: 'h' },
      ])
    ).toBe('Ace Of Spades, King Of Hearts');
    expect(cardsWords([])).toBe('');
  });

  it('a face-down card is not silent', () => {
    expect(FACE_DOWN_WORDS).toBeTruthy();
    expect(cardWords(null)).toBe(FACE_DOWN_WORDS);
    const src = read('../src/components/table/CardImage.tsx');
    /* The back draws with a CSS background rather than an <img>, so it needs
       `role="img"` for the label to be read at all. */
    const back = src.slice(src.indexOf('export function CardBack'));
    expect(back).toMatch(/role="img"/);
    expect(back).toMatch(/aria-label=\{FACE_DOWN_WORDS\}/);
  });

  it('the one renderer takes its alt from the one helper', () => {
    const src = read('../src/components/table/CardImage.tsx');
    expect(src).toMatch(/alt=\{cardWords\(card\)\}/);
    /* The old template must not come back beside it. */
    expect(src).not.toMatch(/alt=\{`\$\{card\.rank\}/);
  });

  it('nothing is announced twice', () => {
    const card = read('../src/components/table/CardImage.tsx');
    /* The fallback glyph sits beside an <img> that KEEPS its alt while hidden,
       so the same card would be read as itself and then as its glyph.
       Bounded by the element's own attribute list - from its class to the
       `style` that ends it - rather than by a byte count that drifts off the
       thing it watches (tests/helpers/sourceWindow.ts). */
    const fallback = sliceBetween(card, 'className="card-image__fallback"', 'style={{');
    expect(fallback).toMatch(/aria-hidden="true"/);

    const felt = read('../src/components/table/CommunityCards.tsx');
    /* The board's region names every card in one sentence, so the cards
       inside it are hidden - otherwise the board is read out twice. */
    expect(felt).toMatch(/cardsWords\(cards\)/);
    expect(felt).toMatch(/community-cards__container" aria-hidden="true"/);
    /* And it must not build its own sentence out of raw fields again. */
    expect(felt).not.toMatch(/\$\{c\.rank\} of \$\{c\.suit\}/);
  });

  it('leaves the poker room its own words', () => {
    /* "Pocket Deuces", not "Pocket Twos". A different vocabulary for a
       different sentence, and deliberately not unified with the card's name. */
    const motion = read('../src/utils/replayMotion.ts');
    expect(motion).toMatch(/'2': 'Deuce'/);
    expect(RANK_WORD['2']).toBe('Two');
  });
});
