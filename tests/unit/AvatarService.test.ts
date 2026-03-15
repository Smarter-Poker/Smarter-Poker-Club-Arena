/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AvatarService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests avatar library size, category distribution, default fallback URL,
 * getUserAvatarUrl default, and getUserAvatars empty input.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

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
  return { supabase: { from: () => buildChain() } };
});

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { avatarService } from '../../src/services/AvatarService';

describe('AvatarService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getAvatarLibrary', () => {
    it('should return 75 avatars', async () => {
      const library = await avatarService.getAvatarLibrary();
      expect(library).toHaveLength(75);
    });

    it('should have 25 free avatars', async () => {
      const library = await avatarService.getAvatarLibrary();
      const free = library.filter((a) => a.category === 'free');
      expect(free).toHaveLength(25);
    });

    it('should have 50 VIP avatars', async () => {
      const library = await avatarService.getAvatarLibrary();
      const vip = library.filter((a) => a.category === 'vip');
      expect(vip).toHaveLength(50);
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
    it('should return default URL when user not found', async () => {
      const url = await avatarService.getUserAvatarUrl('unknown-user');
      expect(url).toBe('/avatars/default-player.png');
    });
  });

  describe('getUserAvatars', () => {
    it('should return empty map for empty input', async () => {
      const map = await avatarService.getUserAvatars([]);
      expect(map.size).toBe(0);
    });

    it('should return default avatars for unknown users', async () => {
      const map = await avatarService.getUserAvatars(['user-1', 'user-2']);
      expect(map.get('user-1')).toBe('/avatars/default-player.png');
      expect(map.get('user-2')).toBe('/avatars/default-player.png');
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

  describe('getHubAvatarUrl', () => {
    it('should return the correct Hub URL', () => {
      expect(avatarService.getHubAvatarUrl()).toBe('https://smarter.poker/hub/avatars-complete');
    });
  });
});
