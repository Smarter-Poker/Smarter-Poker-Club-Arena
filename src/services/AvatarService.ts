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
import { reportError } from '../utils/errorReporter';
import {
  generateAvatarSvg,
  generateDefaultAvatar,
  getAvatarWithFallback,
} from '../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Avatar {
  id: string;
  name: string;
  imageUrl: string;
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

const SUPABASE_STORAGE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public';
const SOCIAL_AVATARS_BUCKET = 'social-media';
const SOCIAL_AVATARS_PREFIX = 'avatars';
const CUSTOM_AVATARS_BUCKET = 'custom-avatars';
const CUSTOM_AVATARS_PREFIX = 'generated';

/** Default avatar — deterministic SVG when no real image exists */
const DEFAULT_AVATAR_SVG = generateDefaultAvatar();

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class AvatarServiceClass {
  /** In-memory cache to avoid re-fetching storage listings */
  private _presetCache: Avatar[] | null = null;
  private _presetCacheTs = 0;
  private static readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get the Hub avatar page URL for embedding or navigation
   */
  getHubAvatarUrl(): string {
    return 'https://smarter.poker/hub/avatars';
  }

  /**
   * Get all available avatars for the gallery.
   *
   * Sources (merged):
   *  1. Preset avatars from social-media/avatars storage bucket (free tier)
   *  2. User's custom generated avatars from user_avatars table + custom-avatars bucket
   *
   * Returns Avatar[] compatible with AvatarGallery component.
   */
  async getAvatarLibrary(userId?: string): Promise<Avatar[]> {
    const results: Avatar[] = [];

    // ── 1. Fetch preset avatars from storage bucket ──
    try {
      const presets = await this._getPresetAvatars();
      results.push(...presets);
    } catch (err) {
      console.warn('[AvatarService] Failed to load preset avatars:', err);
    }

    // ── 2. Fetch user's custom avatars from user_avatars table ──
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
    // Return cache if fresh
    if (this._presetCache && Date.now() - this._presetCacheTs < AvatarServiceClass.CACHE_TTL) {
      return this._presetCache;
    }

    const { data: files, error } = await supabase.storage
      .from(SOCIAL_AVATARS_BUCKET)
      .list(SOCIAL_AVATARS_PREFIX, { limit: 200, sortBy: { column: 'name', order: 'asc' } });

    if (error || !files) {
      // If cache exists but is stale, return stale data rather than nothing
      if (this._presetCache) return this._presetCache;
      return [];
    }

    const avatars: Avatar[] = files
      .filter((f) => f.name && /\.(png|jpg|jpeg|webp|svg)$/i.test(f.name))
      .map((f, index) => {
        const publicUrl = `${SUPABASE_STORAGE_URL}/${SOCIAL_AVATARS_BUCKET}/${SOCIAL_AVATARS_PREFIX}/${f.name}`;
        const cleanName = f.name
          .replace(/\.[^.]+$/, '') // Strip extension
          .replace(/[-_]/g, ' ') // Dashes/underscores → spaces
          .replace(/^[a-f0-9-]{36}$/i, `Avatar ${index + 1}`); // UUID filenames → numbered

        return {
          id: f.name,
          name: cleanName.length > 2 ? cleanName : `Avatar ${index + 1}`,
          imageUrl: publicUrl,
          category: 'free' as const,
          isOwned: true, // Preset avatars are available to all users
        };
      });

    this._presetCache = avatars;
    this._presetCacheTs = Date.now();
    return avatars;
  }

  /**
   * Get a user's current avatar URL from their profile.
   * Falls back to SVG placeholder if no avatar is set.
   */
  async getUserAvatarUrl(userId: string): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('avatar_url, display_name')
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
        .select('id, avatar_url, display_name')
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
      // Update the profile avatar_url (the canonical source)
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ avatar_url: avatarUrl })
        .eq('id', userId);

      if (profileError) {
        reportError(profileError, 'AvatarService.Profile_update_failed');
        return false;
      }

      // Also upsert into user_avatars for history tracking
      const isCustom = avatarUrl.includes(CUSTOM_AVATARS_BUCKET);
      const isPreset = avatarUrl.includes(SOCIAL_AVATARS_BUCKET);

      if (isCustom || isPreset) {
        await supabase.from('user_avatars').upsert(
          {
            user_id: userId,
            avatar_type: isCustom ? 'custom' : 'preset',
            custom_image_url: avatarUrl,
            is_active: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );
      }

      return true;
    } catch (err) {
      reportError(err, 'AvatarService.Error');
      return false;
    }
  }

  /**
   * Open the Hub avatar selector in a new tab/modal.
   * The Hub handles avatar creation + selection and saves to the user's profile.
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
