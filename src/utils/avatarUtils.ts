/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Avatar Display Utilities
 * ═══════════════════════════════════════════════════════════════════════════════
 * Resolves avatar URLs with fallback to DiceBear identicons.
 */

/**
 * Resolve an avatar URL for display, falling back to a generated identicon.
 * @param url - The user's avatar_url from the database
 * @param fallbackId - A unique ID (user_id) used to generate a consistent identicon
 */
export function resolveAvatarDisplay(url?: string | null, fallbackId?: string): string {
  if (url && url.trim()) return url;
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${fallbackId || 'anon'}`;
}

/**
 * Get initials from a display name for avatar placeholders.
 * @param name - Display name or username
 * @returns 1-2 character initials string
 */
export function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return parts[0][0].toUpperCase();
}
