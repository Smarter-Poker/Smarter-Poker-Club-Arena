/** Owner-authored lobby promotions. They are never paid advertising events. */
export interface ClubRotatingBanner {
  id: string;
  title: string;
  imageUrl: string;
  enabled: boolean;
}
export const MAX_ROTATING_BANNERS = 3;

/** Accept only images issued in this club's immutable upload namespace. */
export function isClubRotatingImage(value: unknown, clubId: string): value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]+$/.test(clubId)) return false;
  try {
    const base = new URL(import.meta.env.VITE_SUPABASE_URL);
    const url = new URL(value);
    return (
      url.origin === base.origin &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      new RegExp(
        `^/storage/v1/object/public/club-assets/club-cards/${clubId}-banner-[a-f0-9-]+\\.(jpg|png|webp)$`
      ).test(url.pathname)
    );
  } catch {
    return false;
  }
}
export function validateRotatingBanners(banners: ClubRotatingBanner[], clubId: string): void {
  if (!Array.isArray(banners) || banners.length > MAX_ROTATING_BANNERS)
    throw new Error('Use Up To Three Rotating Banners');
  const ids = new Set<string>();
  for (const banner of banners) {
    if (
      !banner ||
      typeof banner.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(banner.id) ||
      ids.has(banner.id) ||
      typeof banner.title !== 'string' ||
      !banner.title.trim() ||
      banner.title.length > 80 ||
      typeof banner.enabled !== 'boolean' ||
      !isClubRotatingImage(banner.imageUrl, clubId)
    )
      throw new Error('Choose A Valid Club Banner Image And A Title Up To 80 Characters');
    ids.add(banner.id);
  }
}
export function readRotatingBanners(settings: unknown, clubId: string): ClubRotatingBanner[] {
  const value = (settings as { rotating_banners?: unknown } | null)?.rotating_banners;
  if (!Array.isArray(value)) return [];
  // Refuse malformed entries individually; an old or unsafe row never reaches an image fetch.
  return value
    .slice(0, MAX_ROTATING_BANNERS)
    .filter((banner): banner is ClubRotatingBanner => {
      try {
        validateRotatingBanners([banner], clubId);
        return true;
      } catch {
        return false;
      }
    })
    .filter((banner, index, all) => all.findIndex((other) => other.id === banner.id) === index);
}
