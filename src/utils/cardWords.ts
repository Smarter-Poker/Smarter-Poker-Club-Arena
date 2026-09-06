/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CARD, IN WORDS — the one place a card is turned into a sentence
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 7 of the Previous Hand build plan (2026-09-06).
 *
 * Every card face on this platform is one `<img>` (`CardImage`), and its alt
 * text was `` `${card.rank} Of ${SUIT_MAP[card.suit]}` ``. That reads the RANK
 * RAW, so a screen reader announced the ace of spades as **"A Of spades"**, the
 * ten of hearts as **"T Of hearts"**, and a deuce as **"2 Of clubs"**. Every
 * card, on the felt, in the rundown, in the replayer and on a shared hand.
 *
 * A player who cannot see the felt was being read the sprite filename.
 *
 * ONE DEFINITION, because there were already two private ones drifting apart:
 * `replayMotion.ts` said `2 -> 'Deuce'` and `TablePage.tsx` said `2 -> 'Two'`,
 * neither exported, both feeding player-facing labels.
 *
 * THE ONE THAT STAYS SEPARATE, deliberately: `preflopHoleLabel` in
 * `replayMotion.ts` keeps its own `Deuce`, because "Pocket Deuces" is what a
 * poker room says and "Pocket Twos" is not. That is an IDIOM for naming a
 * holding; this file NAMES A CARD, and a card is read "two of clubs". Do not
 * unify them - the words differ because the sentences differ.
 *
 * TITLE CASE, per the house rule (CLAUDE.md 5.7): every player-facing string
 * has the first letter of every word capitalised, and this is read aloud on
 * the surface where a player is least able to correct for it.
 */

import type { DeckCard } from './deckCards';

/** The card's own name. "Two", never "Deuce" - see the header. */
export const RANK_WORD: Record<string, string> = {
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  '10': 'Ten',
  T: 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
  A: 'Ace',
};

/**
 * Suits, singular-cased the way they are spoken: "Ace Of Spades".
 *
 * `CardImage`'s own `SUIT_MAP` is the FILENAME map (`h -> hearts`) and is used
 * to build the sprite path. Reusing it for speech is how the alt text came to
 * say "of spades" in lower case beside a raw rank letter; the two jobs look
 * the same and are not.
 */
export const SUIT_WORD: Record<string, string> = {
  h: 'Hearts',
  d: 'Diamonds',
  c: 'Clubs',
  s: 'Spades',
  hearts: 'Hearts',
  diamonds: 'Diamonds',
  clubs: 'Clubs',
  spades: 'Spades',
};

/** What a face-down card is called, so it is not simply silent. */
export const FACE_DOWN_WORDS = 'Face Down Card';

const rankWord = (rank: unknown): string => {
  const key = String(rank ?? '').toUpperCase();
  return RANK_WORD[key] ?? key;
};

const suitWord = (suit: unknown): string => {
  const key = String(suit ?? '').toLowerCase();
  return SUIT_WORD[key] ?? key;
};

/**
 * One card, spoken. `{rank:'A', suit:'s'}` -> `"Ace Of Spades"`.
 *
 * A card this cannot name returns whatever it was given rather than an empty
 * string: an unfamiliar rank read aloud as itself is worth more than silence,
 * and `CardImage` has its own explicit refusal for a card it cannot READ at
 * all (`failuresAreNeverInvisible.test.ts`).
 */
export function cardWords(card: Pick<DeckCard, 'rank' | 'suit'> | null | undefined): string {
  if (!card) return FACE_DOWN_WORDS;
  return `${rankWord(card.rank)} Of ${suitWord(card.suit)}`;
}

/**
 * A row of cards, spoken as one phrase: "Ace Of Spades, King Of Hearts".
 *
 * For a container that names its whole holding in one label. The cards inside
 * such a container must then be `aria-hidden`, or the board is announced
 * twice - which is what the felt did before this phase.
 */
export function cardsWords(
  cards: Array<Pick<DeckCard, 'rank' | 'suit'>> | null | undefined
): string {
  if (!cards || cards.length === 0) return '';
  return cards.map((c) => cardWords(c)).join(', ');
}
