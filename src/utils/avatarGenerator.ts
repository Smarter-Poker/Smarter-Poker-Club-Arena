/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SVG Avatar Generator — Deterministic, poker-themed placeholder avatars
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Generates unique SVG data-URI avatars based on a seed string (avatar ID or
 * user display name). Each avatar gets a deterministic gradient background
 * and centered initials. Used as fallback when actual avatar images aren't
 * available.
 *
 * Features:
 * - Deterministic: same seed always produces same avatar
 * - Zero network requests (inline SVG data URI)
 * - Visually distinct: 24 hue slots × gradient variations
 * - Poker-themed color palette (dark, rich tones)
 */

// ── Color Generation ─────────────────────────────────────────────────────────

/** Simple string hash for deterministic color selection */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/** Generate a rich gradient pair from a seed */
function seedToColors(seed: string): { bg1: string; bg2: string; text: string } {
  const hash = hashString(seed);
  // 24 hue slots, spread evenly across the wheel
  const hue = (hash % 24) * 15;
  // Saturation: 55-80%, Lightness: 25-40% (dark, rich poker-table tones)
  const sat = 55 + (hash % 26);
  const light = 25 + ((hash >> 8) % 16);
  const hue2 = (hue + 30 + ((hash >> 4) % 30)) % 360;

  return {
    bg1: `hsl(${hue}, ${sat}%, ${light}%)`,
    bg2: `hsl(${hue2}, ${sat + 5}%, ${light + 8}%)`,
    text: light > 35 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.9)',
  };
}

// ── Initials Extraction ──────────────────────────────────────────────────────

/** Extract 1-2 character initials from a name */
function getInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    return words[0].substring(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// ── SVG Generation ───────────────────────────────────────────────────────────

/**
 * Generate an SVG avatar as a data URI string.
 * Deterministic: same seed+name always produces the same image.
 *
 * @param seed - Unique identifier (avatar ID, user ID, etc.)
 * @param name - Display name for initials
 * @param size - SVG viewBox size (default 128)
 * @returns data:image/svg+xml URI string
 */
export function generateAvatarSvg(seed: string, name: string, size = 128): string {
  const { bg1, bg2, text } = seedToColors(seed);
  const initials = getInitials(name);
  const fontSize = initials.length > 1 ? size * 0.38 : size * 0.48;
  const gradientId = `g${hashString(seed) % 9999}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg1}"/>
      <stop offset="100%" stop-color="${bg2}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.15}" fill="url(#${gradientId})"/>
  <text x="50%" y="52%" dominant-baseline="central" text-anchor="middle"
    font-family="system-ui,-apple-system,sans-serif" font-weight="600"
    font-size="${fontSize}" fill="${text}" letter-spacing="1">${initials}</text>
</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Generate a default player avatar (gray with "?" icon)
 */
export function generateDefaultAvatar(size = 128): string {
  return generateAvatarSvg('default-player', '?', size);
}

/** The World Hub serves the avatar library art (Club Arena is hosted under its origin) */
const HUB_ORIGIN = 'https://smarter.poker';

/**
 * Get an avatar URL with SVG fallback.
 *
 * `/avatars/free|vip/*.png` paths ARE real assets — the 75-avatar library the
 * World Hub ships under its public/ dir. Horses and players who equip a
 * library avatar store exactly these paths in profiles.avatar_url. They are
 * mapped to the table-optimized bust art (`/avatars/table/{tier}_{name}.png`).
 * (This function used to treat every /avatars/ path as broken and demote
 * library avatars to generated monograms at the table seats.)
 */
/**
 * Rewrite a Supabase Storage object URL to the image-transform endpoint so the
 * bytes that cross the wire match the box the avatar is drawn in.
 *
 * Dan 2026-08-20 (measured): uploaded avatars are served at whatever the user
 * picked. The owner account's is 1179x1509 / 263 KB and every seat draws it at
 * ~56px. Nine of those is 2.4 MB of avatar on ONE table. Through
 * /render/image/ at 112px the same picture is 3.5 KB.
 *
 * Only public Storage objects are rewritten. Data URIs (the generated SVG
 * fallbacks), Hub library art under /avatars/, SIGNED storage URLs (a
 * different path that the transform endpoint does not accept) and any
 * third-party URL are returned untouched — rewriting any of those would break
 * the image.
 *
 * Note this asks for a SQUARE crop (resize=cover, width == height). Every
 * avatar surface in the app is a square or circular box, which is what makes
 * that correct; it is not a general-purpose image resizer.
 */
export function sizedStorageUrl(url: string, px: number): string {
  if (!url.includes('/storage/v1/object/public/')) return url;
  const [base, query] = url.split('?');
  const rendered = base.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
  // 2x the CSS box so it stays sharp on retina, capped: past ~256px the
  // transform stops being a saving for the sizes we actually draw.
  //
  // The Number.isFinite guard is not theoretical. Math.round(NaN) is NaN and
  // both clamps pass it straight through, so a caller handing us an undefined
  // or not-yet-measured size would have produced `width=NaN&height=NaN` —
  // a 400 from the transform endpoint and a broken avatar for every player at
  // the table. Today's callers pass literals; this is here so the next one
  // that passes a measured value cannot silently break them.
  const requested = Number.isFinite(px) ? Math.round(px * 2) : 128;
  const target = Math.min(512, Math.max(32, requested));
  const params = `width=${target}&height=${target}&resize=cover&quality=80`;
  return query ? `${rendered}?${query}&${params}` : `${rendered}?${params}`;
}

export function getAvatarWithFallback(
  avatarUrl: string | null | undefined,
  seed: string,
  name: string,
  /** CSS pixel size the avatar is drawn at; enables storage-side resizing. */
  displayPx?: number
): string {
  if (avatarUrl && avatarUrl.trim()) {
    // Library avatar → table-optimized bust (absolute URL so it also works
    // when the client runs on a non-Hub origin, e.g. local dev).
    //
    // .webp, not .png (Dan 2026-08-20): the World Hub now ships a lossless
    // WebP beside every one of the 76 /avatars/table/ PNGs — pixel-identical,
    // 40% smaller. Nine seats pull nine of these on every table open, so that
    // is 250 KB -> 150 KB per table. The PNGs are still there; only this line
    // decides which one the client asks for, which is what makes the change
    // reversible in one character.
    //
    // Safe because this path is CONSTRUCTED, never stored: production profiles
    // hold /avatars/free/* and /avatars/vip/*, and not one row holds an
    // /avatars/table/* value. Both the bust-art detector in SeatSlot and the
    // baked-nameplate clip in SeatSlot.css key off the DIRECTORY, not the
    // extension, so neither notices the swap.
    const lib = /^\/avatars\/(free|vip)\/([\w-]+)\.png$/.exec(avatarUrl);
    if (lib) return `${HUB_ORIGIN}/avatars/table/${lib[1]}_${lib[2]}.webp`;
    // Any other Hub-relative avatar path (e.g. already table-optimized)
    if (avatarUrl.startsWith('/avatars/')) return `${HUB_ORIGIN}${avatarUrl}`;
    // Full URL (Supabase storage custom avatars, etc.)
    return displayPx ? sizedStorageUrl(avatarUrl, displayPx) : avatarUrl;
  }
  // Generate deterministic SVG fallback
  return generateAvatarSvg(seed, name);
}
