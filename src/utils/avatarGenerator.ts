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
export function getAvatarWithFallback(
  avatarUrl: string | null | undefined,
  seed: string,
  name: string
): string {
  if (avatarUrl && avatarUrl.trim()) {
    // Library avatar → table-optimized bust (absolute URL so it also works
    // when the client runs on a non-Hub origin, e.g. local dev)
    const lib = /^\/avatars\/(free|vip)\/([\w-]+)\.png$/.exec(avatarUrl);
    if (lib) return `${HUB_ORIGIN}/avatars/table/${lib[1]}_${lib[2]}.png`;
    // Any other Hub-relative avatar path (e.g. already table-optimized)
    if (avatarUrl.startsWith('/avatars/')) return `${HUB_ORIGIN}${avatarUrl}`;
    // Full URL (Supabase storage custom avatars, etc.)
    return avatarUrl;
  }
  // Generate deterministic SVG fallback
  return generateAvatarSvg(seed, name);
}