export const DIAMOND_ARENA_CLUB_ID = '002c2d27-9584-4e52-835a-bb2be148fc81';
export const DIAMOND_ARENA_SLUG = 'diamond-arena';
export const DIAMOND_ARENA_ENTRY = Object.freeze({
  id: DIAMOND_ARENA_CLUB_ID,
  slug: DIAMOND_ARENA_SLUG,
  name: 'Diamond Arena',
  entity_type: 'club' as const,
  automatic_entry: true,
});

/**
 * The Diamond Arena has two stable public keys: its UUID and slug. Keeping the
 * comparison here prevents navigation chrome and entry surfaces from drifting.
 */
export function isDiamondArenaClubKey(value: string | null | undefined): boolean {
  if (!value) return false;
  let key = value;
  try {
    key = decodeURIComponent(value);
  } catch {
    // A malformed route is not the Diamond Arena.
  }
  return key.toLowerCase() === DIAMOND_ARENA_SLUG || key.toLowerCase() === DIAMOND_ARENA_CLUB_ID;
}

export function isDiamondArenaClubPath(pathname: string): boolean {
  const match = pathname.replace(/\/+$/, '').match(/^\/clubs\/([^/]+)(?:\/|$)/);
  return isDiamondArenaClubKey(match?.[1]);
}
