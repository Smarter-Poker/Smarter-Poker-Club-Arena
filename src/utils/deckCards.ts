/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DECK CARD NORMALISER — stored hand-history cards to CardImage cards
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * hand_history stores cards two different ways:
 *   hole_cards / board   -> [{ rank: 'T', suit: 'diamonds' }]
 *   community_cards      -> ['Tdiamonds', 'Kspades']  (TEXT[])
 *
 * CardImage wants { rank: '2'..'9'|'T'|'J'|'Q'|'K'|'A', suit: 'h'|'d'|'c'|'s' }.
 * Every past attempt to bridge that gap did it inline and got it wrong in a
 * different way, so it lives here once. Anything unrecognised is DROPPED rather
 * than rendered as a broken card.
 */

import type { Card as DeckCard } from '../components/table/CardImage';

export type { DeckCard };

const SUIT_LETTER: Record<string, DeckCard['suit']> = {
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
  spades: 's',
  h: 'h',
  d: 'd',
  c: 'c',
  s: 's',
};

/** One stored card in either shape. */
export type StoredCard = { rank?: string; suit?: string } | string | null | undefined;

function normalizeOne(input: StoredCard): DeckCard | null {
  if (!input) return null;

  let rawRank = '';
  let rawSuit = '';

  if (typeof input === 'string') {
    const m = input.match(/^(10|[2-9TJQKAtjqka])(hearts|diamonds|clubs|spades|[hdcs])$/);
    if (!m) return null;
    rawRank = m[1];
    rawSuit = m[2];
  } else {
    rawRank = String(input.rank ?? '');
    rawSuit = String(input.suit ?? '');
  }

  const suit = SUIT_LETTER[rawSuit.toLowerCase()];
  const rank = rawRank.toUpperCase() === '10' ? 'T' : rawRank.toUpperCase();
  if (!suit || !/^([2-9]|T|J|Q|K|A)$/.test(rank)) return null;
  return { rank: rank as DeckCard['rank'], suit };
}

/** Normalise a stored card array. Unparseable entries are dropped. */
export function toDeckCards(cards: StoredCard[] | null | undefined): DeckCard[] {
  if (!Array.isArray(cards)) return [];
  return cards.map(normalizeOne).filter((c): c is DeckCard => c !== null);
}
