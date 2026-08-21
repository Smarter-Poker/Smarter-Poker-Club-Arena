/**
 * ♠ CLUB ARENA — Avatar Service (Database-Driven)
 *
 * All avatar data comes from Supabase:
 *   - profiles.avatar_url        → user's current active avatar
 *   - user_avatars table         → user's generated/custom avatar history
 *   - social-media/avatars/      → AI-generated preset avatar storage bucket
 *   - custom-avatars/generated/  → user's custom AI-generated avatars
 *
 * The World Hub at smarter.poker/hub/avatars handles the full
 * avatar creation + selection experience. Club Arena reads the results.
 *
 * SVG fallback (avatarGenerator) is used ONLY when no real image exists.
 */

import { supabase } from '../lib/supabase';
import { reportError, reportWarning } from '../utils/errorReporter';
import { generateDefaultAvatar, getAvatarWithFallback } from '../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Avatar {
  id: string;
  name: string;
  imageUrl: string;
  /**
   * Optional lightweight image for grid tiles. When absent, tiles fall back to
   * imageUrl. Exists because the VIP artwork is 1.1 MB apiece at 1024x1024 and
   * a gallery paints 74 of them at 48px.
   */
  thumbUrl?: string;
  category: 'free' | 'vip' | 'custom';
  isOwned: boolean;
}

export interface UserAvatar {
  userId: string;
  avatarId: string;
  avatarUrl: string;
  displayName: string;
}

// Re-export for convenience
export { getAvatarWithFallback } from '../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SOCIAL_AVATARS_BUCKET = 'social-media';
const CUSTOM_AVATARS_BUCKET = 'custom-avatars';
/**
 * Dan 2026-08-21: "they can now only use avatars."
 *
 * The `avatars` storage bucket that held user-uploaded photos is gone from this
 * file, along with `downscaleImage` and `uploadAvatar` that fed it. The bucket
 * itself is deliberately NOT deleted — existing objects are what the migration
 * that moves affected players onto library art rolls back to if it ever has to.
 */

/** Default avatar — deterministic SVG when no real image exists */
const DEFAULT_AVATAR_SVG = generateDefaultAvatar();

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeAvatarUrl(url: string): string {
  if (!url) return url;

  // 1. Hub native paths: /avatars/vip/slug.png -> /avatars/table/vip_slug@2x.webp
  const hubMatch = url.match(/^\/avatars\/(vip|free)\/([^/.]+)\.png$/i);
  if (hubMatch) {
    return `/avatars/table/${hubMatch[1]}_${hubMatch[2]}@2x.webp`;
  }

  // 2. Storage bucket paths: .../social-media/avatars/vip_slug.png -> /avatars/table/vip_slug@2x.webp
  const bucketMatch = url.match(
    /\/social-media\/avatars\/(vip|free)_([^/.]+)\.(png|jpg|jpeg|webp)$/i
  );
  if (bucketMatch) {
    return `/avatars/table/${bucketMatch[1]}_${bucketMatch[2]}@2x.webp`;
  }

  // 3. Already normalized? Just to be safe, if it's /avatars/table/...webp, leave it.
  return url;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIBRARY-ONLY GUARD — Dan 2026-08-21: "they can now only use avatars"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THIS IS THE ENFORCEMENT POINT, NOT THE UI.
 *
 * The upload tab and the "Use Profile Photo" button are removed too, but on
 * their own that is a locked door in a building with no walls: `setUserAvatar`
 * accepted ANY string, and `normalizeAvatarUrl` returns anything it does not
 * recognise unchanged. Any caller — a cached bundle, the console, the Hub, a
 * future feature — could still write a photograph straight into
 * `profiles.avatar_url`. A rule that lives only in a component is not a rule.
 *
 * WHAT COUNTS AS AN AVATAR
 *   /avatars/...                     Hub library art, any tier
 *   .../custom-avatars/generated/... AI-generated art. NOT a photograph: it is
 *                                    drawn from a text prompt, and the
 *                                    photo-likeness route that could turn a
 *                                    selfie into one is deleted.
 *   data:image/svg+xml,...           the generated monogram fallback
 *
 * Refused: Supabase Storage uploads (`/avatars/<uid>/…`,
 * `/social-media/avatars/<uid>/…`) and external OAuth photos such as
 * lh3.googleusercontent.com, which is what "Use Profile Photo" wrote.
 *
 * Note the ORDER dependency with normalizeAvatarUrl: `/avatars/vip/x.png` and
 * `social-media/avatars/vip_x.png` are both legitimate ways of naming library
 * art and both become `/avatars/table/...` there, so the guard must run AFTER
 * normalisation or it would reject the very paths the Hub sends.
 */
export function isLibraryAvatarUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('data:image/svg+xml')) return true;
  if (/\/custom-avatars\/generated\//i.test(url)) return true;
  if (/^\/avatars\//i.test(url)) return true;
  if (/^https?:\/\/[^/]+\/avatars\//i.test(url)) return true;
  return false;
}

class AvatarServiceClass {
  /** In-memory cache to avoid re-fetching storage listings */
  private _presetCache: Avatar[] | null = null;
  private _presetCacheTs = 0;
  private static readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get the Hub avatar page URL for embedding or navigation
   */
  getHubAvatarUrl(): string {
    // /hub/avatars is the live avatar page (avatars-complete was removed;
    // the Hub keeps a redirect for old builds, but link directly here)
    return 'https://smarter.poker/hub/avatars';
  }

  /**
   * Get all available avatars for the gallery.
   *
   * Sources (merged):
   *  1. Preset avatars from social-media/avatars storage bucket (free tier)
   *  2. The Hub's VIP avatar library, served same-origin from /avatars/vip/
   *  3. User's custom generated avatars from user_avatars table + custom-avatars bucket
   *
   * Returns Avatar[] compatible with AvatarGallery component.
   */
  async getAvatarLibrary(userId?: string): Promise<Avatar[]> {
    const results: Avatar[] = [];

    // ── 1. Fetch ALL preset avatars (Free + VIP) from Hub API ──
    try {
      const presets = await this._getPresetAvatars();
      results.push(...presets);
    } catch (err) {
      console.warn('[AvatarService] Failed to load preset avatars:', err);
    }

    // ── 3. Fetch user's custom avatars from user_avatars table ──
    if (userId) {
      try {
        const { data: userAvatars, error } = await supabase
          .from('user_avatars')
          .select('id, avatar_type, preset_avatar_id, custom_image_url, custom_prompt, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });

        if (!error && userAvatars) {
          for (const ua of userAvatars) {
            const imageUrl = ua.custom_image_url || '';
            if (!imageUrl) continue;

            results.push({
              id: ua.id,
              name: ua.custom_prompt
                ? ua.custom_prompt.slice(0, 30) + (ua.custom_prompt.length > 30 ? '...' : '')
                : 'Custom Avatar',
              imageUrl,
              category: 'custom',
              isOwned: true,
            });
          }
        }
      } catch (err) {
        console.warn('[AvatarService] Failed to load custom avatars:', err);
      }
    }

    return results;
  }

  /**
   * Fetch preset avatar images from the social-media/avatars storage bucket.
   * Results are cached for 5 minutes to avoid repeated storage API calls.
   */
  private async _getPresetAvatars(): Promise<Avatar[]> {
    if (this._presetCache && Date.now() - this._presetCacheTs < AvatarServiceClass.CACHE_TTL) {
      return this._presetCache;
    }

    try {
      const response = await fetch('/api/avatars');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const hubAvatars = await response.json();

      const avatars: Avatar[] = hubAvatars.map((entry: any) => {
        // Generate thumb URL exactly as the Hub's normalizeAvatarUrl does,
        // to match the legacy 'free_shark' / 'vip_wolf' pattern.
        const tierLower = (entry.tier || 'free').toLowerCase();
        const slugMatch = entry.image.match(/\/([^/.]+)\.png$/i);
        const slug = slugMatch ? slugMatch[1] : entry.id;
        const thumbUrl = `/avatars/table/${tierLower}_${slug}@2x.webp`;

        return {
          id: entry.id,
          name: entry.name,
          imageUrl: entry.image,
          thumbUrl,
          category: tierLower === 'vip' ? 'vip' : 'free',
          isOwned: true,
        };
      });

      this._presetCache = avatars;
      this._presetCacheTs = Date.now();
      return avatars;
    } catch (err) {
      console.warn('[AvatarService] Unified Avatar API fetch failed:', err);
      if (this._presetCache) return this._presetCache;
      return [];
    }
  }

  /**
   * Get a user's current avatar URL from their profile.
   * Falls back to SVG placeholder if no avatar is set.
   */
  async getUserAvatarUrl(userId: string): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('avatar_url:arena_avatar_url, display_name')
        .eq('id', userId)
        .maybeSingle();

      if (error || !data?.avatar_url) {
        return getAvatarWithFallback(null, userId, data?.display_name || 'Player');
      }

      return data.avatar_url;
    } catch (err) {
      reportError(err, 'AvatarService.Error');
      return DEFAULT_AVATAR_SVG;
    }
  }

  /**
   * Get avatars for multiple users (for table display).
   * Falls back to SVG placeholders for users without avatars.
   */
  async getUserAvatars(userIds: string[]): Promise<Map<string, string>> {
    const avatarMap = new Map<string, string>();

    if (userIds.length === 0) return avatarMap;

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, avatar_url:arena_avatar_url, display_name')
        .in('id', userIds);

      if (!error && data) {
        for (const profile of data) {
          avatarMap.set(
            profile.id,
            profile.avatar_url ||
              getAvatarWithFallback(null, profile.id, profile.display_name || 'Player')
          );
        }
      }
    } catch (err) {
      reportError(err, 'AvatarService.Error');
    }

    // Set SVG fallback for any missing users
    for (const userId of userIds) {
      if (!avatarMap.has(userId)) {
        avatarMap.set(userId, getAvatarWithFallback(null, userId, 'Player'));
      }
    }

    return avatarMap;
  }

  /**
   * Update user's avatar in both profiles and user_avatars tables.
   */
  async setUserAvatar(userId: string, avatarUrl: string): Promise<boolean> {
    try {
      avatarUrl = normalizeAvatarUrl(avatarUrl);

      /**
       * Reported and refused, not thrown. A caller holding a photo URL should
       * leave the player's existing avatar alone rather than crash the screen
       * they are standing on — and the report is what tells us a write path was
       * missed, which is the only way we would ever find one.
       */
      if (!isLibraryAvatarUrl(avatarUrl)) {
        reportWarning(
          'Refused a non-library avatar URL - profile pictures are no longer supported',
          'AvatarService.setUserAvatar',
          { userId, avatarUrl: avatarUrl.slice(0, 120) }
        );
        return false;
      }

      /* Dan 2026-08-21: writes go to arena_avatar_url, NEVER avatar_url.
         avatar_url is the player's social media profile picture. This picker
         lives in Club Arena and chooses the Club Arena avatar; writing the old
         column is what silently changed 17 people's social pictures earlier
         today. The two columns are now separate precisely so that cannot
         recur - and tests/unit/arenaAvatarSeparation.test.ts fails the build
         if any write in this app names avatar_url again. */
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ arena_avatar_url: avatarUrl })
        .eq('id', userId);

      if (profileError) {
        reportError(profileError, 'AvatarService.Profile_update_failed');
        return false;
      }

      // Also upsert into user_avatars for history tracking.
      // Previously gated on the URL containing a known bucket name, which
      // meant uploads and OAuth profile photos were silently never recorded.
      // Every avatar the user actually picks now gets a history row.
      const avatarType = avatarUrl.includes(CUSTOM_AVATARS_BUCKET)
        ? 'custom'
        : avatarUrl.includes(SOCIAL_AVATARS_BUCKET)
          ? 'preset'
          : 'custom';

      const { error: historyError } = await supabase.from('user_avatars').upsert(
        {
          user_id: userId,
          avatar_type: avatarType,
          custom_image_url: avatarUrl,
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

      // History is best-effort: the profile write above is the source of
      // truth, so a history failure must not report the change as failed.
      if (historyError) {
        console.warn('[AvatarService] Avatar history write failed:', historyError.message);
      }

      return true;
    } catch (err) {
      reportError(err, 'AvatarService.Error');
      return false;
    }
  }

  /**
   * Profile pictures were removed 2026-08-21 (Dan: "they can now only use
   * avatars"). Two methods lived here and both are gone:
   *
   *   getProfilePhotoUrl()  read the OAuth provider photo out of auth user
   *                         metadata, which is what the "Use Profile Photo"
   *                         button wrote into profiles.avatar_url.
   *   uploadAvatar()        took a File, downscaled it, and pushed it to the
   *                         `avatars` storage bucket.
   *
   * Neither has a caller any more. They are recorded here rather than deleted
   * silently so the next person looking for "where did upload go" finds an
   * answer instead of an absence — and so nobody re-adds one thinking it was
   * an oversight. isLibraryAvatarUrl() above is what actually enforces this.
   */

  /**
   * Open the Hub avatar creator in a new tab/modal.
   * The Hub handles AI avatar generation and saves to the user's profile.
   */
  openAvatarSelector(): void {
    const url = this.getHubAvatarUrl();
    window.open(url, '_blank', 'width=800,height=600');
  }

  /**
   * Check if a user has VIP access for premium avatars
   */
  async hasVipAccess(userId: string): Promise<boolean> {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('is_vip')
        .eq('id', userId)
        .maybeSingle();

      return data?.is_vip || false;
    } catch (err) {
      reportError(err, 'AvatarService.Error');
      return false;
    }
  }

  /**
   * Get the default avatar SVG (for components that need a sync fallback)
   */
  getDefaultAvatarUrl(): string {
    return DEFAULT_AVATAR_SVG;
  }
}

export const avatarService = new AvatarServiceClass();
export default avatarService;
