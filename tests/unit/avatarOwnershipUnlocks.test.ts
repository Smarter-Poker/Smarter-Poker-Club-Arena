/**
 * AVATAR OWNERSHIP — the gallery must read the unlock ledger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS BROKEN
 *
 * `AvatarGallery` decided a tile was locked with `category === 'vip' && !isVip`
 * and nothing in Club Arena ever read `avatar_unlocks`. The marketplace sells
 * avatars ("Redeemed. Avatar Unlocked", MyItemsTab) and `fn_redeem_shop_item`
 * writes that row — so a player could pay for an avatar, be told they owned it,
 * and still find it behind the VIP badge. Production carried exactly one such
 * row when this was found (`unlock_method = 'club_shop'`).
 *
 * WHY IT NEEDED A TOKEN SET AND NOT A STRING COMPARE
 *
 * Three producers write `avatar_unlocks.avatar_id` in three formats and none of
 * them is the library id the gallery holds:
 *
 *   unlock_free_avatars()   'free_shark'        tier prefix + slug
 *   fn_redeem_shop_item     'shark'             bare slug (the live row)
 *   AVATAR_LIBRARY entry    'free-animal-004'   hyphenated library id
 *
 * A naive `unlocked.has(avatar.id)` would have matched none of them and the fix
 * would have looked applied while changing nothing — which is worse than the
 * bug, because it stops anyone looking again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const unlockRows = { data: [] as Array<{ avatar_id: string }>, error: null as any };
const userAvatarRows = { data: [] as any[], error: null as any };

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'avatar_unlocks') {
        return { select: () => ({ eq: () => Promise.resolve(unlockRows) }) };
      }
      if (table === 'user_avatars') {
        return {
          select: () => ({
            eq: () => ({ order: () => Promise.resolve(userAvatarRows) }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    },
  },
}));

import {
  avatarService,
  normalizeUnlockToken,
  unlockTokensForAvatar,
  isAvatarUnlocked,
} from '../../src/services/AvatarService';

const HUB_AVATARS = [
  { id: 'free-animal-004', name: 'Shark', tier: 'FREE', image: '/avatars/free/shark.png' },
  { id: 'vip-fantasy-002', name: 'Wolf', tier: 'VIP', image: '/avatars/vip/wolf.png' },
  { id: 'vip-fantasy-003', name: 'Dragon', tier: 'VIP', image: '/avatars/vip/dragon.png' },
];

function bustCache() {
  (avatarService as any)._presetCache = null;
  (avatarService as any)._presetCacheTs = 0;
}

beforeEach(() => {
  bustCache();
  unlockRows.data = [];
  unlockRows.error = null;
  userAvatarRows.data = [];
  userAvatarRows.error = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => HUB_AVATARS }) as Response)
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unlock id normalization', () => {
  it('treats hyphens and underscores as the same character', () => {
    expect(normalizeUnlockToken('free-animal-004')).toBe('free_animal_004');
    expect(normalizeUnlockToken('  Free_Shark ')).toBe('free_shark');
  });

  it('returns an empty string for nothing, rather than the string "null"', () => {
    // A row with a null avatar_id must not become a token that could match.
    expect(normalizeUnlockToken(null)).toBe('');
    expect(normalizeUnlockToken(undefined)).toBe('');
  });

  it('derives every identity an avatar could have been unlocked under', () => {
    const tokens = unlockTokensForAvatar({
      id: 'vip-fantasy-002',
      imageUrl: '/avatars/vip/wolf.png',
      category: 'vip',
    });
    expect(tokens).toContain('vip_fantasy_002'); // library id
    expect(tokens).toContain('wolf'); // bare slug, what the shop writes
    expect(tokens).toContain('vip_wolf'); // tier-prefixed slug
  });

  it('reads the slug through a retina thumb path too', () => {
    const tokens = unlockTokensForAvatar({
      id: 'x',
      imageUrl: '/avatars/table/vip_wolf@2x.webp',
      category: 'vip',
    });
    expect(tokens).toContain('vip_wolf');
  });

  it('an empty unlock set owns nothing', () => {
    expect(
      isAvatarUnlocked(
        { id: 'vip-fantasy-002', imageUrl: '/avatars/vip/wolf.png', category: 'vip' },
        new Set()
      )
    ).toBe(false);
  });
});

describe('getUnlockedAvatarIds', () => {
  it('stores both the prefixed and bare form of each unlock', async () => {
    unlockRows.data = [{ avatar_id: 'free_shark' }];
    const set = await avatarService.getUnlockedAvatarIds('u1');
    expect(set.has('free_shark')).toBe(true);
    expect(set.has('shark')).toBe(true);
  });

  it('fails CLOSED: a query error yields no unlocks, never a full grant', async () => {
    // Failing open here would hand the entire VIP library to every player the
    // first time this query hiccups. A wrongly-shown lock is recoverable.
    unlockRows.error = { code: '42501', message: 'permission denied' };
    unlockRows.data = null as any;
    const set = await avatarService.getUnlockedAvatarIds('u1');
    expect(set.size).toBe(0);
  });

  it('returns empty for an anonymous caller without querying', async () => {
    unlockRows.data = [{ avatar_id: 'shark' }];
    const set = await avatarService.getUnlockedAvatarIds('');
    expect(set.size).toBe(0);
  });
});

describe('getAvatarLibraryResult ownership', () => {
  it('free art is owned by everyone, with or without an unlock row', async () => {
    const { avatars } = await avatarService.getAvatarLibraryResult('u1');
    expect(avatars.find((a) => a.id === 'free-animal-004')!.isOwned).toBe(true);
  });

  it('VIP art is NOT owned by default', async () => {
    const { avatars } = await avatarService.getAvatarLibraryResult('u1');
    expect(avatars.find((a) => a.id === 'vip-fantasy-002')!.isOwned).toBe(false);
  });

  it('a shop unlock written as a BARE SLUG marks the VIP avatar owned', async () => {
    // This is the exact shape of the one live production row.
    unlockRows.data = [{ avatar_id: 'wolf' }];
    const { avatars } = await avatarService.getAvatarLibraryResult('u1');
    expect(avatars.find((a) => a.id === 'vip-fantasy-002')!.isOwned).toBe(true);
    expect(avatars.find((a) => a.id === 'vip-fantasy-003')!.isOwned).toBe(false);
  });

  it('an unlock written as a TIER-PREFIXED slug also matches', async () => {
    unlockRows.data = [{ avatar_id: 'vip_wolf' }];
    const { avatars } = await avatarService.getAvatarLibraryResult('u1');
    expect(avatars.find((a) => a.id === 'vip-fantasy-002')!.isOwned).toBe(true);
  });

  it('an unlock written as the HYPHENATED library id also matches', async () => {
    unlockRows.data = [{ avatar_id: 'vip-fantasy-002' }];
    const { avatars } = await avatarService.getAvatarLibraryResult('u1');
    expect(avatars.find((a) => a.id === 'vip-fantasy-002')!.isOwned).toBe(true);
  });

  it('one unlock does not leak ownership onto the rest of the library', async () => {
    unlockRows.data = [{ avatar_id: 'wolf' }];
    const { avatars } = await avatarService.getAvatarLibraryResult('u1');
    const ownedVip = avatars.filter((a) => a.category === 'vip' && a.isOwned);
    expect(ownedVip.map((a) => a.id)).toEqual(['vip-fantasy-002']);
  });

  it('the shared preset cache carries no player entitlements', async () => {
    // The cache is one object shared by every user in the tab. If ownership
    // were baked into it, the second player to open the gallery would inherit
    // the first player's unlocks.
    unlockRows.data = [{ avatar_id: 'wolf' }];
    await avatarService.getAvatarLibraryResult('u1');
    unlockRows.data = [];
    const { avatars } = await avatarService.getAvatarLibraryResult('u2');
    expect(avatars.find((a) => a.id === 'vip-fantasy-002')!.isOwned).toBe(false);
  });
});

describe('getAvatarLibraryResult failure reporting', () => {
  it('a Hub API failure reports presetsFailed, not an empty library', async () => {
    bustCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response)
    );
    const result = await avatarService.getAvatarLibraryResult('u1');
    expect(result.presetsFailed).toBe(true);
    expect(result.avatars).toHaveLength(0);
  });

  it('a healthy API reports presetsFailed false', async () => {
    const result = await avatarService.getAvatarLibraryResult('u1');
    expect(result.presetsFailed).toBe(false);
  });

  it('a user_avatars error reports customFailed', async () => {
    userAvatarRows.error = { code: '42501', message: 'permission denied' };
    userAvatarRows.data = null as any;
    const result = await avatarService.getAvatarLibraryResult('u1');
    expect(result.customFailed).toBe(true);
    // Presets still loaded, so the modal is not blanket-broken.
    expect(result.presetsFailed).toBe(false);
    expect(result.avatars.length).toBeGreaterThan(0);
  });

  it('getAvatarLibrary still returns a plain array for existing callers', async () => {
    const lib = await avatarService.getAvatarLibrary('u1');
    expect(Array.isArray(lib)).toBe(true);
    expect(lib.length).toBe(HUB_AVATARS.length);
  });
});
