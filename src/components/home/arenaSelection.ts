import { DIAMOND_ARENA_CLUB_ID, SHARK_CLUB_ID } from '../../lib/constants';

interface ArenaCard {
  id: string;
  club_id?: number | string;
  slug?: string;
}
const isShark = (card: ArenaCard) =>
  Number(card.club_id) === SHARK_CLUB_ID || card.slug === 'shark-club';

/** Platform entries stay adjacent; joined clubs retain their pins and saved order. */
export function orderArenaCards<T extends ArenaCard>(
  cards: T[],
  pinned: string[],
  saved: unknown
): T[] {
  const order = new Map(
    (Array.isArray(saved) ? saved : [])
      .filter((id): id is string => typeof id === 'string')
      .map((id, index) => [id, index])
  );
  const rank = (card: T) => (isShark(card) ? 0 : card.id === DIAMOND_ARENA_CLUB_ID ? 1 : 2);
  return [...cards].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) ||
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

/** An absent or retired choice opens Shark. A valid last arena remains selected. */
export function initialArenaIndex(cards: ArenaCard[], lastId: string | null): number {
  const saved = cards.findIndex((card) => card.id === lastId || card.slug === lastId);
  if (saved >= 0) return saved;
  return Math.max(0, cards.findIndex(isShark));
}
