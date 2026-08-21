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

const SUPABASE_STORAGE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public';
const SOCIAL_AVATARS_BUCKET = 'social-media';
const SOCIAL_AVATARS_PREFIX = 'avatars';
const CUSTOM_AVATARS_BUCKET = 'custom-avatars';
const CUSTOM_AVATARS_PREFIX = 'generated';
/** Destination for user-uploaded photos. Public, 10MB cap, path must be <uid>/... */
const UPLOAD_AVATARS_BUCKET = 'avatars';

/** Default avatar — deterministic SVG when no real image exists */
const DEFAULT_AVATAR_SVG = generateDefaultAvatar();

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Downscale an image file to fit within `maxPx` on its longest edge, preserving
 * aspect ratio. Returns a JPEG (or PNG when the source has transparency), or
 * rejects so the caller can fall back to the original.
 *
 * Uses createImageBitmap + canvas: no dependency, and it never decodes the file
 * twice. Images already inside the box are returned untouched.
 */
async function downscaleImage(file: File, maxPx: number): Promise<File> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;

  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= maxPx) return file;

    const scale = maxPx / longest;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);

    // PNG keeps alpha (avatars are often cut-outs); everything else is JPEG,
    // which is dramatically smaller for photographs.
    const keepAlpha = file.type === 'image/png';
    const mime = keepAlpha ? 'image/png' : 'image/jpeg';
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, mime, keepAlpha ? undefined : 0.85)
    );
    if (!blob) return file;

    const name = file.name.replace(/\.[^.]+$/, '') + (keepAlpha ? '.png' : '.jpg');
    return new File([blob], name, { type: mime, lastModified: Date.now() });
  } finally {
    bitmap.close?.();
  }
}

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
      avatarUrl = normalizeAvatarUrl(avatarUrl);
      // Update the profile avatar_url (the canonical source)
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ avatar_url: avatarUrl })
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
   * The signed-in user's photo from their identity provider (Google, etc).
   *
   * There is no separate "profile picture" column - profiles.avatar_url IS
   * the profile picture. The distinct thing a user means by "use my profile
   * pic" is the photo attached to the account they signed in with, which
   * lives in the auth user metadata rather than in profiles.
   *
   * Returns null when the account has no provider photo (most accounts are
   * email/password), so callers can hide the option instead of offering a
   * button that does nothing.
   */
  async getProfilePhotoUrl(): Promise<string | null> {
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data?.user) return null;

      const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
      // Providers disagree on the key: Google uses `picture`, most Supabase
      // OAuth flows normalise to `avatar_url`. Accept either.
      const candidate = meta.avatar_url ?? meta.picture;

      if (typeof candidate !== 'string' || candidate.length === 0) return null;
      if (!/^https?:\/\//i.test(candidate)) return null;

      return candidate;
    } catch (err) {
      reportError(err, 'AvatarService.getProfilePhotoUrl');
      return null;
    }
  }

  /**
   * Upload a user-supplied image and return its public URL.
   *
   * The gallery previously turned the chosen file into a base64 data URL and
   * wrote that straight into profiles.avatar_url. A 5MB photo becomes a ~6.8MB
   * string in a text column that is then re-sent to every client rendering
   * that player at a table. This uploads to the `avatars` bucket instead and
   * stores only the URL.
   *
   * Path must be `<uid>/<file>` to satisfy the bucket's INSERT policy
   * (auth.uid() = foldername(name)[1]).
   */
  async uploadAvatar(userId: string, file: File): Promise<{ url?: string; error?: string }> {
    const MAX_BYTES = 5 * 1024 * 1024;
    const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

    if (!ALLOWED.includes(file.type)) {
      return { error: 'Use a JPG, PNG or WebP image.' };
    }
    /**
     * The 5 MB limit applies to what we UPLOAD, not to what the user picked.
     *
     * It used to be checked here, before any downscaling — so a perfectly
     * ordinary phone photo was rejected outright even though the very next
     * step would have turned it into ~50 KB. The only thing that genuinely
     * has to be bounded up front is what we ask the browser to DECODE, since
     * that is the part that can hurt a low-end device.
     */
    const MAX_DECODE_BYTES = 25 * 1024 * 1024;
    if (file.size > MAX_DECODE_BYTES) {
      return {
        error: `That image is ${(file.size / 1048576).toFixed(1)}MB - too large to process. Please pick one under 25MB.`,
      };
    }

    /**
     * Downscale before it ever leaves the browser.
     *
     * Dan 2026-08-20 (measured): avatars were stored exactly as supplied. The
     * owner account's is 1179x1509 / 263 KB and the largest box any of them is
     * drawn in is 56 CSS px. Serving is already handled — sizedStorageUrl()
     * asks Supabase's transform endpoint for the display size — but the
     * original is still what gets stored, backed up and billed, and the
     * transform has to chew through it on every cold cache.
     *
     * 512px square covers every present use at 3x DPR with room to spare.
     * If anything here fails (no canvas, exotic colour profile, an image the
     * decoder rejects) we upload the ORIGINAL rather than block the user —
     * a slightly heavy avatar beats a broken upload.
     */
    const prepared = await downscaleImage(file, 512).catch((err) => {
      // Falling back to the original is deliberate — a slightly heavy avatar
      // beats a blocked upload. Reporting it is deliberate too: if the decoder
      // starts rejecting a whole class of file, that must be visible rather
      // than showing up months later as a bucket full of 5 MB originals.
      reportError(err, 'AvatarService.downscale_failed_using_original');
      return file;
    });
    const usable = prepared.size < file.size ? prepared : file;

    // Now that the size is final, enforce the real limit. Reaching this means
    // downscaling could not get the file under 5 MB — which in practice means
    // the fallback ran and we are holding the original.
    if (usable.size > MAX_BYTES) {
      return {
        error: `That image is still ${(usable.size / 1048576).toFixed(1)}MB after resizing. The limit is 5MB.`,
      };
    }

    const ext = usable.type === 'image/png' ? 'png' : usable.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `${userId}/avatar-${Date.now()}.${ext}`;

    try {
      const { error: uploadError } = await supabase.storage
        .from(UPLOAD_AVATARS_BUCKET)
        .upload(path, usable, { cacheControl: '3600', upsert: true, contentType: usable.type });

      if (uploadError) {
        reportError(uploadError, 'AvatarService.uploadAvatar');
        return { error: 'Upload failed. Please try again.' };
      }

      const { data } = supabase.storage.from(UPLOAD_AVATARS_BUCKET).getPublicUrl(path);
      if (!data?.publicUrl) return { error: 'Upload succeeded but no URL was returned.' };

      return { url: data.publicUrl };
    } catch (err) {
      reportError(err, 'AvatarService.uploadAvatar');
      return { error: 'Upload failed. Please try again.' };
    }
  }

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
