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
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';
import { cardWords, cardsWords, FACE_DOWN_WORDS, RANK_WORD } from '../src/utils/cardWords';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

/** Every file under a directory, so the sweep below cannot miss a folder. */
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

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
    /* And it must not build its own sentence out of raw fields again. */
    expect(felt).not.toMatch(/\$\{c\.rank\} of \$\{c\.suit\}/);

    /* THE HIDING IS PER CARD, NEVER ON THE CONTAINER (deep dive 2026-09-06).
       This pin used to read `community-cards__container" aria-hidden="true"`
       and it was GREEN while the felt was broken: `aria-hidden` is inherited,
       one of those cards becomes the Squeeze To Reveal button, and hiding the
       container took a focusable control out of the accessibility tree while
       leaving it in the tab order. The pin was watching the MECHANISM, so it
       could not see that the mechanism had swallowed a control.
       The property is pinned where it can actually be observed - against the
       rendered DOM, in tests/components/RiverSqueeze.test.tsx. Here we only
       forbid the shape that caused it. */
    expect(felt).not.toMatch(/community-cards__container"\s+aria-hidden/);
    expect(felt).toMatch(/aria-hidden=\{host && interactiveHold \? undefined : true\}/);
  });

  it('no spoken label anywhere is built out of raw card fields', () => {
    /* DEEP DIVE 2026-09-06. The phase fixed every card FACE and missed a
       CONTROL: Crazy Pineapple's discard button said `Discard ${card.rank}${
       card.suit}` - "Discard As" - and a button's aria-label REPLACES its
       content as the accessible name, so the corrected alt on the CardImage
       inside it was never read. The one card a player is asked to choose,
       under a timer that folds the hand, was the one still read as the
       sprite's field values.
       One renderer was never the whole surface: a label is written by hand
       anywhere somebody needs one, so the class has to be pinned, not the
       instance. */
    /* WIDENED 2026-09-06, after the first version of this pin shipped and was
       still wrong. It matched only ATTRIBUTES (aria-label / alt / title), so
       it passed while the CONFIRM BUTTON fifty lines below the label it had
       just fixed still PRINTED "Discard As" - visible text, read by everyone,
       the last thing anybody sees before the card is gone. Found by grepping
       the shipped bundle, not the source.
       So the rule is the property, not the shape: a raw rank immediately
       followed by a raw suit is a card being named in field values, wherever
       a player reads it.
       `${c.rank}${String(c.suit).charAt(0)}` is deliberately NOT matched -
       that is the plain-text hand summary a player COPIES, where poker
       notation is the correct output and not speech. */
    const attrOnly = /(aria-label|alt|title)=\{`[^`]*\$\{[^}]*\.(rank|suit)\b/;
    /* A raw rank immediately followed by a raw suit, inside a template. */
    const rawPair = /`[^`]*\$\{[^}]*\.rank\}\$\{[^}]*\.suit\}[^`]*`/g;

    /**
     * Is this template a SENTENCE, or an identity string?
     *
     * `${c.rank}${c.suit}` on its own is how this codebase keys a card - React
     * keys, `indexOf` against the engine's card order, the PokerStars export's
     * own notation. Those are correct and nobody reads them. Flagging them
     * would put eight false positives in front of the next agent, and a law
     * that cries wolf is a law that gets deleted.
     *
     * What makes the two real defects different is PROSE beside the pair:
     * "Discard ${...}${...}". So strip the interpolations and look for a word.
     */
    const isSentence = (tpl: string) => /[A-Za-z]{2,}/.test(tpl.replace(/\$\{[^}]*\}/g, ''));

    const offenders: string[] = [];
    for (const rel of walk(resolve(__dirname, '../src'))) {
      if (!rel.endsWith('.tsx')) continue;
      const src = readFileSync(rel, 'utf8');
      for (const line of src.split('\n')) {
        /* `.rank` is also a LEADERBOARD position, which is a legitimate thing
           to say out loud. Only card-shaped names count. */
        const attr = attrOnly.test(line) && (/\.suit\b/.test(line) || /\bcard\.rank\b/.test(line));
        const spokenPair = (line.match(rawPair) ?? []).some(isSentence);
        if (attr || spokenPair) {
          offenders.push(`${rel.split('/src/')[1]}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, 'a card named in raw field values where a player reads it').toEqual([]);
  });

  it('leaves the poker room its own words', () => {
    /* "Pocket Deuces", not "Pocket Twos". A different vocabulary for a
       different sentence, and deliberately not unified with the card's name. */
    const motion = read('../src/utils/replayMotion.ts');
    expect(motion).toMatch(/'2': 'Deuce'/);
    expect(RANK_WORD['2']).toBe('Two');
  });
});
