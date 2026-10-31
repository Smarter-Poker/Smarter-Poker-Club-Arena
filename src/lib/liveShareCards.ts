import { normalizeCard, normalizeCards, type NormalizedCard } from '../utils/tableGeometry';

/** Hidden slots stay private. Only cards already readable by this client travel. */
export function visibleShareCards(raw: unknown): NormalizedCard[] {
  return normalizeCards(raw);
}

/** A missing board slot must not move a later river into the turn position. */
export function shareBoardPrefix(raw: unknown): NormalizedCard[] {
  if (!Array.isArray(raw)) return [];
  const cards: NormalizedCard[] = [];
  for (const value of raw.slice(0, 5)) {
    const card = normalizeCard(value);
    if (!card) break;
    cards.push(card);
  }
  return cards;
}

/** Preserve run numbers: an unavailable run cannot be replaced by a later run. */
export function shareExtraBoards(raw: unknown): NormalizedCard[][] {
  if (!Array.isArray(raw)) return [];
  const boards: NormalizedCard[][] = [];
  for (const run of raw.slice(1)) {
    const cards = shareBoardPrefix(run);
    if (cards.length < 3) break;
    boards.push(cards);
  }
  return boards;
}
