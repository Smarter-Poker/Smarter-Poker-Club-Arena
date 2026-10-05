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
 * Online now, by the one definition: the presence door's answer
 * (fn_profile_presence, through src/lib/ownProfile.ts readPresence), which
 * counts the persisted flag only while its heartbeat is under five minutes old
 * (SOCIAL_PRESENCE_FRESH_MS) - the browser never receives last_seen (ruling
 * 25). `livePresence` is that door re-asked every minute while the row is on
 * screen (useProfilePresence); `loadedAnswer` is what the same door said when
 * the page loaded, used until the first re-ask lands.
 *
 * Until 2026-10-05 a Realtime presence channel "won" here. Only people can
 * join one - a house player never opens a browser - so it was a second
 * definition of online that told a person from a house player. There is one
 * definition now: tests/presence-has-one-definition.law.test.ts.
 */
export function isSocialProfileOnline(
  userId: string,
  livePresence: ReadonlyMap<string, boolean>,
  loadedAnswer: boolean
): boolean {
  const live = livePresence.get(userId);
  return live === undefined ? loadedAnswer === true : live === true;
}

export function chunkSocialProfileIds(ids: readonly string[], size = 100): string[][] {
  if (size < 1) throw new Error('Social profile batch size must be at least 1');
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
