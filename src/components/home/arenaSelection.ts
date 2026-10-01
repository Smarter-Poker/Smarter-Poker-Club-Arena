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

/**
 * The pinned clubs a device saved, read safely (Diamond Phase 11, line 7:
 * stale storage). The value is only ever written as a JSON array of ids, but
 * storage is shared with every build this origin has served and with the World
 * Hub, and `JSON.parse` accepts `null`, `{}` or `"x"` without complaint - each
 * of which reached `.includes` in the home sort and threw, taking the Poker
 * Arena home down with it. Anything but an array of strings is discarded.
 */
export function savedPinnedClubIds(raw: string | null): string[] {
  try {
    const saved: unknown = JSON.parse(raw || '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** An absent or retired choice opens Shark. A valid last arena remains selected. */
export function initialArenaIndex(cards: ArenaCard[], lastId: string | null): number {
  const saved = cards.findIndex((card) => card.id === lastId || card.slug === lastId);
  if (saved >= 0) return saved;
  return Math.max(0, cards.findIndex(isShark));
}
