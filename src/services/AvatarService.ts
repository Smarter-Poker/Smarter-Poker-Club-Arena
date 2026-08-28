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
import {
  ALL_COSMETICS,
  isCosmeticOwned,
  resolveCosmetic,
  type AvatarCosmetic,
} from '../cosmetics/avatarCosmetics';

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

/**
 * What `getAvatarLibraryResult` reports back.
 *
 * The plain `Avatar[]` this service used to return could not tell an empty
 * library from a broken one, and the gallery rendered both as the same calm
 * "No preset avatars available." — a failed query drawn as a successful empty
 * state. The flags exist so the caller can say which one actually happened.
 */
export interface AvatarLibraryResult {
  avatars: Avatar[];
  /** The Hub preset API did not answer. Presets and VIP art are UNKNOWN, not absent. */
  presetsFailed: boolean;
  /** The user_avatars read failed. "Mine" is UNKNOWN, not empty. */
  customFailed: boolean;
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNLOCK MATCHING — three id conventions for one ledger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `avatar_unlocks.avatar_id` is written by three different producers that never
 * agreed on a format, which is why the gallery ignoring the table was easy to
 * miss: nothing would have matched even if it had looked.
 *
 *   unlock_free_avatars()   'free_shark'          tier prefix + slug
 *   fn_redeem_shop_item     'shark'               bare slug (the one live row)
 *   AVATAR_LIBRARY entry id 'free-animal-004'     library id, hyphenated
 *
 * So ownership is decided on a TOKEN SET, not a string compare: an avatar is
 * owned when any of its identities appears in the player's unlock set. Hyphens
 * and underscores are the same character here, and a `free_`/`vip_` prefix on a
 * stored unlock is stripped as well as kept.
 */
export function normalizeUnlockToken(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Every id under which this avatar could legitimately have been unlocked. */
export function unlockTokensForAvatar(avatar: {
  id: string;
  imageUrl: string;
  category: Avatar['category'];
}): string[] {
  const tokens = new Set<string>();
  tokens.add(normalizeUnlockToken(avatar.id));

  /* The retina suffix is stripped AFTER the match, not inside it: `[^/.]+` is
     greedy and swallows `@2x` whole, so an inline `(?:@2x)?` never fires and
     `/avatars/table/vip_wolf@2x.webp` yielded the slug `vip_wolf@2x` — a token
     that matches no unlock row anywhere. */
  const slugMatch = avatar.imageUrl.match(/\/([^/.]+)\.(?:png|jpe?g|webp)$/i);
  const rawSlug = slugMatch ? slugMatch[1].replace(/@\d+x$/i, '') : '';
  const slug = normalizeUnlockToken(rawSlug);
  if (slug) {
    tokens.add(slug);
    tokens.add(`${avatar.category === 'vip' ? 'vip' : 'free'}_${slug}`);
  }

  tokens.delete('');
  return Array.from(tokens);
}

/** True when any identity of `avatar` appears in the player's unlock set. */
export function isAvatarUnlocked(
  avatar: { id: string; imageUrl: string; category: Avatar['category'] },
  unlocked: Set<string>
): boolean {
  if (unlocked.size === 0) return false;
  return unlockTokensForAvatar(avatar).some((t) => unlocked.has(t));
}

class AvatarServiceClass {
  /** In-memory cache to avoid re-fetching storage listings */
  private _presetCache: Avatar[] | null = null;
  private _presetCacheTs = 0;
  private static readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private _avatarWriteTails = new Map<string, Promise<void>>();
  private _cosmeticWriteTails = new Map<string, Promise<void>>();

  /**
   * Preserve the user's tap order for writes to the same profile row. Without
   * this, a slower first avatar request can finish after a faster second one
   * and silently become the durable selection even though the UI shows the
   * second. The tail always resolves so one failed mutation cannot block the
   * next correction.
   */
  private async _runOrdered<T>(
    tails: Map<string, Promise<void>>,
    userId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const previous = tails.get(userId) ?? Promise.resolve();
    const task = previous.then(work);
    const tail = task.then(
      () => undefined,
      () => undefined
    );
    tails.set(userId, tail);
    try {
      return await task;
    } finally {
      if (tails.get(userId) === tail) tails.delete(userId);
    }
  }

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
    return (await this.getAvatarLibraryResult(userId)).avatars;
  }

  /**
   * The same library, plus whether each source actually answered.
   *
   * `getAvatarLibrary` stays for callers that only want the list; anything that
   * RENDERS the list should use this instead, so "the API is down" and "there
   * are none" do not reach the player as the same sentence.
   */
  async getAvatarLibraryResult(userId?: string): Promise<AvatarLibraryResult> {
    const results: Avatar[] = [];
    let customFailed = false;

    // ── 1. Presets (Free + VIP) from the Hub API, and what this player owns ──
    const [presetOutcome, unlocked] = await Promise.all([
      this._getPresetAvatars(),
      userId ? this.getUnlockedAvatarIds(userId) : Promise.resolve(new Set<string>()),
    ]);

    for (const preset of presetOutcome.avatars) {
      /* Free art is owned by everyone. VIP art is owned when the player bought
         or was granted it — which is what avatar_unlocks records and what this
         gallery used to ignore entirely, so a redeemed shop avatar stayed
         locked behind the VIP badge the player had just paid to bypass. */
      results.push({
        ...preset,
        isOwned: preset.category === 'free' || isAvatarUnlocked(preset, unlocked),
      });
    }

    // ── 2. The user's own generated avatars from user_avatars ──
    if (userId) {
      try {
        const { data: userAvatars, error } = await supabase
          .from('user_avatars')
          .select('id, avatar_type, preset_avatar_id, custom_image_url, custom_prompt, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });

        if (error) {
          customFailed = true;
          reportWarning('user_avatars read failed', 'AvatarService.getAvatarLibraryResult', {
            code: error.code,
          });
        } else if (userAvatars) {
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
        customFailed = true;
        console.warn('[AvatarService] Failed to load custom avatars:', err);
      }
    }

    return { avatars: results, presetsFailed: presetOutcome.failed, customFailed };
  }

  /**
   * Which avatars this player has unlocked, as a normalized token set.
   *
   * A read failure returns an EMPTY set and says so in the breadcrumb rather
   * than pretending everything is owned — failing closed here means at worst a
   * player sees a lock they should not; failing open would hand VIP art to
   * everyone the first time the query hiccups.
   */
  async getUnlockedAvatarIds(userId: string): Promise<Set<string>> {
    const out = new Set<string>();
    if (!userId) return out;

    try {
      const { data, error } = await supabase
        .from('avatar_unlocks')
        .select('avatar_id')
        .eq('user_id', userId);

      if (error) {
        reportWarning('avatar_unlocks read failed', 'AvatarService.getUnlockedAvatarIds', {
          code: error.code,
        });
        return out;
      }

      for (const row of data || []) {
        const token = normalizeUnlockToken(row?.avatar_id);
        if (!token) continue;
        out.add(token);
        // Stored as 'free_shark' by unlock_free_avatars, as 'shark' by the shop.
        out.add(token.replace(/^(free|vip)_/, ''));
      }
    } catch (err) {
      reportError(err, 'AvatarService.getUnlockedAvatarIds');
    }

    return out;
  }

  /**
   * Fetch the preset avatar catalog from the Hub's unified avatar API.
   * Results are cached for 5 minutes to avoid repeated round trips.
   *
   * Returns `failed` rather than just an empty list: the caller has to be able
   * to tell "the Hub said there are none" from "the Hub said nothing".
   */
  private async _getPresetAvatars(): Promise<{ avatars: Avatar[]; failed: boolean }> {
    if (this._presetCache && Date.now() - this._presetCacheTs < AvatarServiceClass.CACHE_TTL) {
      return { avatars: this._presetCache, failed: false };
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
          /* Placeholder. Real ownership is decided per-player in
             getAvatarLibraryResult against avatar_unlocks; the cache is shared
             across users so it must not carry anyone's entitlements. */
          isOwned: false,
        };
      });

      this._presetCache = avatars;
      this._presetCacheTs = Date.now();
      return { avatars, failed: false };
    } catch (err) {
      console.warn('[AvatarService] Unified Avatar API fetch failed:', err);
      // A stale cache is a better answer than none, and it is not a failure to
      // report: the player still sees the real library.
      if (this._presetCache) return { avatars: this._presetCache, failed: false };
      return { avatars: [], failed: true };
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
    return this._runOrdered(this._avatarWriteTails, userId, async () => {
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
    });
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

  // ═════════════════════════════════════════════════════════════════════════
  //  AVATAR COSMETICS — frames + auras
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * What this player currently has equipped.
   *
   * `ok` exists for the same reason `AvatarLibraryResult` has `presetsFailed`:
   * a failed read and "nothing equipped" are both `{frame:null, aura:null}`, and
   * a picker that draws them identically tells the player their gold frame was
   * never bought. The caller has to be able to tell the two apart.
   */
  async getCosmetics(
    userId: string
  ): Promise<{ frame: string | null; aura: string | null; ok: boolean }> {
    if (!userId) return { frame: null, aura: null, ok: false };
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('equipped_frame, equipped_aura')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        reportWarning('profiles cosmetics read failed', 'AvatarService.getCosmetics', {
          code: error.code,
        });
        return { frame: null, aura: null, ok: false };
      }

      /* Resolved, not passed through. A row can hold a retired token or one
         from a build we have not shipped yet; returning it raw would push an
         unrenderable value into the picker's selected state and the player
         would see nothing highlighted with no explanation. */
      return {
        frame: resolveCosmetic(data?.equipped_frame, 'frame')?.id ?? null,
        aura: resolveCosmetic(data?.equipped_aura, 'aura')?.id ?? null,
        ok: true,
      };
    } catch (err) {
      reportError(err, 'AvatarService.getCosmetics');
      return { frame: null, aura: null, ok: false };
    }
  }

  /**
   * The catalog, annotated with what this player owns.
   *
   * `ok:false` means ownership is UNKNOWN. Callers must render that as "we could
   * not check" and refuse to equip, not as "you own nothing" — the difference
   * between a lock a player understands and a purchase that appears to have
   * evaporated.
   */
  async getCosmeticCatalog(
    userId: string
  ): Promise<{ cosmetics: (AvatarCosmetic & { isOwned: boolean })[]; ok: boolean }> {
    if (!userId) {
      /* A free cosmetic is owned even by nobody (2026-08-27, the three-free
         rule): it consults neither VIP status nor the ledger, so a signed-out
         or unresolved account still sees the free tier as available rather
         than as six locked tiles it can never explain. */
      return {
        cosmetics: ALL_COSMETICS.map((c) => ({ ...c, isOwned: c.tier === 'free' })),
        ok: false,
      };
    }

    /* TWO INDEPENDENT SOURCES, TRACKED SEPARATELY.
       An earlier version of this method ANDed a single `ok` into every
       `isOwned`, which reads as prudent and is not: a VIP whose unlock-ledger
       query hiccupped would have been told they own nothing, and the frame they
       pay for would vanish on a transient error. VIP membership is a complete
       answer for a vip-tier cosmetic on its own — it does not need the ledger
       to have answered. So each source contributes only what it actually knows,
       and `ok` reports whether the picture is complete. */
    let vipOk = true;
    let ledgerOk = true;

    const vipPromise = (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_vip')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        vipOk = false;
        reportWarning('is_vip read failed', 'AvatarService.getCosmeticCatalog', {
          code: error.code,
        });
        return false;
      }
      return Boolean(data?.is_vip);
    })();

    const unlockPromise = (async () => {
      const { data, error } = await supabase
        .from('avatar_unlocks')
        .select('avatar_id')
        .eq('user_id', userId);
      if (error) {
        ledgerOk = false;
        reportWarning('avatar_unlocks read failed', 'AvatarService.getCosmeticCatalog', {
          code: error.code,
        });
        return new Set<string>();
      }
      const out = new Set<string>();
      for (const row of data || []) {
        const token = normalizeUnlockToken(row?.avatar_id);
        if (token) out.add(token);
      }
      return out;
    })();

    const [isVip, unlockedTokens] = await Promise.all([vipPromise, unlockPromise]);

    return {
      cosmetics: ALL_COSMETICS.map((c) => ({
        ...c,
        /* Each source contributes only what it actually proved. FAILING CLOSED
           HAPPENS AT ONE PLACE ONLY - inside each promise above, where an error
           returns `false` / an empty set. Re-checking `vipOk` / `ledgerOk` here
           as well was tried and removed: it is unreachable belt-and-braces (the
           values are already safe by then), so no test could tell it from its
           own absence, and an untestable guard is indistinguishable from a
           decorative one. One guard, in one place, with a test that can see it. */
        isOwned: isCosmeticOwned(c, { isVip, unlockedTokens }),
      })),
      ok: vipOk && ledgerOk,
    };
  }

  /**
   * Equip (or clear) a frame and an aura.
   *
   * `null` means unequip and is always permitted. Anything else must resolve in
   * the catalog AND be owned — checked here so the player gets a sentence
   * instead of a Postgres error, and checked AGAIN by
   * `trg_profiles_cosmetics_ownership`, which is the actual guard. This method
   * is the polite half; the trigger is the half that cannot be skipped by
   * anyone who opens devtools.
   *
   * `profiles` is written first and is the source of truth: it is what the seat
   * query on the engine reads and what every other player's realtime
   * subscription is watching. `user_avatars` mirrors it for parity with the
   * World Hub's AvatarContext, and a mirror failure does not fail the equip.
   */
  async setCosmetics(
    userId: string,
    frame: string | null,
    aura: string | null
  ): Promise<{ ok: boolean; reason?: 'not-owned' | 'unknown-cosmetic' | 'write-failed' }> {
    if (!userId) return { ok: false, reason: 'write-failed' };

    return this._runOrdered(this._cosmeticWriteTails, userId, async () => {
      const resolvedFrame = frame ? resolveCosmetic(frame, 'frame') : null;
      const resolvedAura = aura ? resolveCosmetic(aura, 'aura') : null;
      if ((frame && !resolvedFrame) || (aura && !resolvedAura)) {
        return { ok: false, reason: 'unknown-cosmetic' };
      }

      if (resolvedFrame || resolvedAura) {
        /* `ok` is deliberately NOT consulted here. Ownership is decided per
         cosmetic, and a cosmetic that is not in `ownedIds` is refused whether
         that is because the player does not own it or because the source that
         would have proved it did not answer. Bailing on `!ok` instead would
         refuse a VIP their own frame whenever the unrelated unlock-ledger query
         happened to fail. */
        const { cosmetics } = await this.getCosmeticCatalog(userId);
        const ownedIds = new Set(cosmetics.filter((c) => c.isOwned).map((c) => c.id));
        if (resolvedFrame && !ownedIds.has(resolvedFrame.id)) {
          return { ok: false, reason: 'not-owned' };
        }
        if (resolvedAura && !ownedIds.has(resolvedAura.id)) {
          return { ok: false, reason: 'not-owned' };
        }
      }

      const payload = {
        equipped_frame: resolvedFrame?.id ?? null,
        equipped_aura: resolvedAura?.id ?? null,
      };

      try {
        const { error: profileError } = await supabase
          .from('profiles')
          .update(payload)
          .eq('id', userId);

        if (profileError) {
          reportError(profileError, 'AvatarService.setCosmetics_profile');
          /* 23514 is the ownership trigger firing. It reaches here only when the
           client-side check above passed and the database disagreed, which
           means the entitlement changed underneath us — report it as
           not-owned so the player reads the true reason. */
          return {
            ok: false,
            reason: profileError.code === '23514' ? 'not-owned' : 'write-failed',
          };
        }

        const { error: mirrorError } = await supabase
          .from('user_avatars')
          .update(payload)
          .eq('user_id', userId);

        if (mirrorError) {
          console.warn('[AvatarService] Cosmetics mirror write failed:', mirrorError.message);
        }

        return { ok: true };
      } catch (err) {
        reportError(err, 'AvatarService.setCosmetics');
        return { ok: false, reason: 'write-failed' };
      }
    });
  }
}

export const avatarService = new AvatarServiceClass();
export default avatarService;
