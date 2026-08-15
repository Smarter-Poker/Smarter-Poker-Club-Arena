/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AvatarService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the storage-backed avatar library, category distribution, the
 * generated-SVG default fallback, getUserAvatarUrl default, and
 * getUserAvatars empty input.
 *
 * NOTE (2026-08): the avatar library is no longer a hardcoded 75-entry
 * (25 free / 50 VIP) array. getAvatarLibrary() now lists the
 * `social-media/avatars` storage bucket for presets (all category 'free')
 * and merges the user's `user_avatars` rows (category 'custom'). There is
 * no 'vip' category any more. The default avatar likewise moved from
 * '/avatars/default-player.png' to a generated inline SVG data URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

// Preset avatar files as the `social-media/avatars` bucket would list them.
// `notes.txt` is a non-image and must be filtered out; `ab.png` has a name too
// short to use as a label and must fall back to a positional "Avatar N" name.
const { BUCKET_FILES } = vi.hoisted(() => ({
  BUCKET_FILES: [
    { name: 'ace-hunter.png' },
    { name: 'bluff_queen.jpg' },
    { name: 'chip-leader.webp' },
    { name: 'river-rat.svg' },
    { name: 'ab.png' },
    { name: 'notes.txt' },
  ],
}));

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      storage: {
        from: () => ({
          list: () => Promise.resolve({ data: BUCKET_FILES, error: null }),
        }),
      },
    },
  };
});

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { avatarService } from '../../src/services/AvatarService';
import { getAvatarWithFallback } from '../../src/utils/avatarGenerator';

/** Every preset image in BUCKET_FILES (i.e. everything except notes.txt) */
const PRESET_IMAGE_NAMES = [
  'ace-hunter.png',
  'bluff_queen.jpg',
  'chip-leader.webp',
  'river-rat.svg',
  'ab.png',
];

describe('AvatarService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getAvatarLibrary', () => {
    it('should return one avatar per image file in the preset bucket', async () => {
      // Was a hardcoded 75-entry library; presets now come from the
      // social-media/avatars storage bucket, and non-images are skipped.
      const library = await avatarService.getAvatarLibrary();
      expect(library).toHaveLength(PRESET_IMAGE_NAMES.length);
      expect(library.map((a) => a.id)).toEqual(PRESET_IMAGE_NAMES);
    });

    it('should mark every preset avatar as category "free"', async () => {
      // Was 25 free out of 75; every bucket preset is now free-tier.
      const library = await avatarService.getAvatarLibrary();
      const free = library.filter((a) => a.category === 'free');
      expect(free).toHaveLength(PRESET_IMAGE_NAMES.length);
    });

    it('should expose no VIP avatars (tier removed — presets are free, user art is custom)', async () => {
      // Was 50 VIP avatars; the 'vip' tier no longer exists in the library.
      const library = await avatarService.getAvatarLibrary();
      expect(library.filter((a) => a.category === 'vip')).toHaveLength(0);
      for (const avatar of library) {
        expect(['free', 'custom']).toContain(avatar.category);
      }
    });

    it('should build public storage URLs and humanised names for presets', async () => {
      const library = await avatarService.getAvatarLibrary();
      const byId = new Map(library.map((a) => [a.id, a]));
      expect(byId.get('ace-hunter.png')!.imageUrl).toBe(
        'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/social-media/avatars/ace-hunter.png'
      );
      expect(byId.get('ace-hunter.png')!.name).toBe('ace hunter');
      expect(byId.get('bluff_queen.jpg')!.name).toBe('bluff queen');
      // Names of 2 chars or fewer fall back to a positional label (1-indexed).
      expect(byId.get('ab.png')!.name).toBe('Avatar 5');
    });

    it('free avatars should all have isOwned=true', async () => {
      const library = await avatarService.getAvatarLibrary();
      const free = library.filter((a) => a.category === 'free');
      for (const avatar of free) {
        expect(avatar.isOwned).toBe(true);
      }
    });

    it('every avatar should have unique id', async () => {
      const library = await avatarService.getAvatarLibrary();
      const ids = library.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('getUserAvatarUrl', () => {
    it('should return a generated SVG data URL when user not found', async () => {
      // Was the static '/avatars/default-player.png'; the fallback is now a
      // deterministic inline SVG monogram seeded on the user id.
      const url = await avatarService.getUserAvatarUrl('unknown-user');
      expect(url.startsWith('data:image/svg+xml,')).toBe(true);
      expect(url.length).toBeGreaterThan('data:image/svg+xml,'.length);
      expect(url).toBe(getAvatarWithFallback(null, 'unknown-user', 'Player'));
    });

    it('should generate a different fallback avatar per user', async () => {
      const a = await avatarService.getUserAvatarUrl('user-a');
      const b = await avatarService.getUserAvatarUrl('user-b');
      expect(a).not.toBe(b);
    });

    it('should be deterministic for the same user', async () => {
      const first = await avatarService.getUserAvatarUrl('stable-user');
      const second = await avatarService.getUserAvatarUrl('stable-user');
      expect(first).toBe(second);
    });
  });

  describe('getUserAvatars', () => {
    it('should return empty map for empty input', async () => {
      const map = await avatarService.getUserAvatars([]);
      expect(map.size).toBe(0);
    });

    it('should return distinct generated SVG avatars for unknown users', async () => {
      // Was the shared '/avatars/default-player.png' for every user; each user
      // now gets their own deterministic inline SVG monogram.
      const map = await avatarService.getUserAvatars(['user-1', 'user-2']);
      expect(map.get('user-1')).toBe(getAvatarWithFallback(null, 'user-1', 'Player'));
      expect(map.get('user-2')).toBe(getAvatarWithFallback(null, 'user-2', 'Player'));
      expect(map.get('user-1')!.startsWith('data:image/svg+xml,')).toBe(true);
      expect(map.get('user-2')!.startsWith('data:image/svg+xml,')).toBe(true);
      expect(map.get('user-1')).not.toBe(map.get('user-2'));
    });
  });

  describe('setUserAvatar', () => {
    it('should return true on success (mocked)', async () => {
      const result = await avatarService.setUserAvatar('user-1', '/avatars/poker-shark.png');
      expect(result).toBe(true);
    });
  });

  describe('hasVipAccess', () => {
    it('should return false when user not found', async () => {
      const result = await avatarService.hasVipAccess('unknown-user');
      expect(result).toBe(false);
    });
  });

  describe('getDefaultAvatarUrl', () => {
    it('should return a generated SVG data URL, not a static png path', () => {
      // Was '/avatars/default-player.png'; now generateDefaultAvatar().
      const url = avatarService.getDefaultAvatarUrl();
      expect(url.startsWith('data:image/svg+xml,')).toBe(true);
      expect(url).not.toBe('/avatars/default-player.png');
    });
  });

  describe('getHubAvatarUrl', () => {
    it('should return the correct Hub URL', () => {
      expect(avatarService.getHubAvatarUrl()).toBe('https://smarter.poker/hub/avatars');
    });
  });
});
