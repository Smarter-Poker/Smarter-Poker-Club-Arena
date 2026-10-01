import { playerDisplayName, type NameableProfile } from './playerDisplayName';

export interface SocialGraphProfile extends NameableProfile {
  id: string;
  avatar_url?: string | null;
  /** The presence door's answer (fn_profile_presence): online now, with the
      five-minute heartbeat rule applied server-side. Never the raw flag. */
  is_online?: boolean | null;
}

export interface ResolvedSocialProfile {
  available: boolean;
  name: string;
  avatarUrl?: string;
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
    sourceOnline: profile.is_online === true,
  };
}

/**
 * Realtime presence wins. Otherwise the persisted signal counts only while its
 * heartbeat is fresh, so a stale `is_online=true` row cannot keep somebody
 * online forever after a disconnected device disappears.
 *
 * Since 2026-10-01 that freshness test runs in the database: a player's
 * last-seen time is theirs alone (ruling 22, docs/DIAMOND-RULINGS.md), so the
 * browser never receives it, and `presenceOnline` is the presence door's
 * answer (fn_profile_presence, src/lib/ownProfile.ts readPresence), which
 * applies SOCIAL_PRESENCE_FRESH_MS to the flag before answering. An offline
 * friend reads "Offline"; how long ago they left is not shown.
 */
export function isSocialProfileOnline(
  userId: string,
  liveUserIds: ReadonlySet<string>,
  presenceOnline: boolean
): boolean {
  return liveUserIds.has(userId) || presenceOnline === true;
}

export function chunkSocialProfileIds(ids: readonly string[], size = 100): string[][] {
  if (size < 1) throw new Error('Social profile batch size must be at least 1');
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
