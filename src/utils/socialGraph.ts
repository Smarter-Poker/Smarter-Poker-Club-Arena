import { playerDisplayName, type NameableProfile } from './playerDisplayName';

export interface SocialGraphProfile extends NameableProfile {
  id: string;
  avatar_url?: string | null;
  is_online?: boolean | null;
  last_seen?: string | null;
}

export interface ResolvedSocialProfile {
  available: boolean;
  name: string;
  avatarUrl?: string;
  lastSeen?: string;
  sourceOnline: boolean;
}

export const SOCIAL_PRESENCE_FRESH_MS = 5 * 60 * 1000;

/**
 * Resolve a relationship edge without inventing a person when its profile is
 * unavailable. The relationship remains visible and removable, but message,
 * challenge, and profile actions can be withheld by the caller.
 */
export function resolveSocialProfile(
  profile: SocialGraphProfile | null | undefined
): ResolvedSocialProfile {
  if (!profile) {
    return {
      available: false,
      name: 'Player Profile Unavailable',
      sourceOnline: false,
    };
  }

  return {
    available: true,
    name: playerDisplayName(profile, 'arena'),
    avatarUrl: profile.avatar_url || undefined,
    lastSeen: profile.last_seen || undefined,
    sourceOnline: profile.is_online === true,
  };
}

/**
 * Realtime presence wins. The persisted profile signal is accepted only while
 * its heartbeat is fresh, so a stale `is_online=true` row cannot keep somebody
 * online forever after a disconnected device disappears.
 */
export function isSocialProfileOnline(
  userId: string,
  liveUserIds: ReadonlySet<string>,
  sourceOnline: boolean,
  lastSeen?: string,
  now = Date.now()
): boolean {
  if (liveUserIds.has(userId)) return true;
  if (!sourceOnline || !lastSeen) return false;
  const seenAt = Date.parse(lastSeen);
  return Number.isFinite(seenAt) && now - seenAt <= SOCIAL_PRESENCE_FRESH_MS;
}

export function formatSocialLastSeen(lastSeen?: string, now = Date.now()): string {
  if (!lastSeen) return 'Offline';
  const seenAt = Date.parse(lastSeen);
  if (!Number.isFinite(seenAt)) return 'Offline';

  const elapsedMinutes = Math.max(0, Math.floor((now - seenAt) / 60_000));
  if (elapsedMinutes < 2) return 'Active moments ago';
  if (elapsedMinutes < 60) return `Active ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Active ${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `Active ${elapsedDays}d ago`;
  return 'Offline';
}

export function chunkSocialProfileIds(ids: readonly string[], size = 100): string[][] {
  if (size < 1) throw new Error('Social profile batch size must be at least 1');
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
