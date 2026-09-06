/**
 * AvatarService — REWRITTEN 2026-08-21 against the unified Hub avatar API.
 *
 * The old file pinned the retired Supabase-storage preset bucket (mocked
 * storage.list, asserted public-URL shapes). Presets now come from
 * `/api/avatars` on the Hub ("unify avatar fetching to read directly from
 * World Hub", 2026-08-21) and are mapped to Avatar objects with a
 * `/avatars/table/<tier>_<slug>@2x.webp` thumb. These tests mock fetch and
 * pin THAT mapping — plus the failure contract: an API error must degrade to
 * an empty preset list (with cache fallback), never a throw.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { avatarService } from '../../src/services/AvatarService';

const HUB_AVATARS = [
  { id: 'av_shark', name: 'Shark', tier: 'FREE', image: '/avatars/free/shark.webp' },
  { id: 'av_wolf', name: 'Wolf', tier: 'VIP', image: '/avatars/vip/wolf.webp' },
  // The live catalog intentionally grants this VIP-directory art as FREE.
  { id: 'av_wrestler', name: 'Wrestler', tier: 'FREE', image: '/avatars/vip/wrestler.webp' },
];

describe('AvatarService presets via the unified Hub API', () => {
  beforeEach(() => {
    // Bust the service's in-memory preset cache between tests.
    (avatarService as any)._presetCache = null;
    (avatarService as any)._presetCacheTs = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => HUB_AVATARS }) as Response)
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps each Hub entry to an owned Avatar with the tiered thumb URL', async () => {
    const lib = await avatarService.getAvatarLibrary();
    const shark = lib.find((a) => a.id === 'av_shark');
    const wolf = lib.find((a) => a.id === 'av_wolf');
    expect(shark).toBeTruthy();
    expect(wolf).toBeTruthy();
    expect(shark!.imageUrl).toBe('/avatars/free/shark.webp');
    expect(shark!.thumbUrl).toBe('/avatars/table/free_shark@2x.webp');
    expect(wolf!.thumbUrl).toBe('/avatars/table/vip_wolf@2x.webp');
    expect(lib.find((a) => a.id === 'av_wrestler')!.thumbUrl).toBe(
      '/avatars/table/vip_wrestler@2x.webp'
    );
    expect(shark!.isOwned).toBe(true);
  });

  it('tier decides the category: VIP entries are vip, everything else is free', async () => {
    const lib = await avatarService.getAvatarLibrary();
    expect(lib.find((a) => a.id === 'av_shark')!.category).toBe('free');
    expect(lib.find((a) => a.id === 'av_wolf')!.category).toBe('vip');
  });

  it('an API failure degrades to no presets — never a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response)
    );
    const lib = await avatarService.getAvatarLibrary();
    expect(Array.isArray(lib)).toBe(true);
    expect(lib.filter((a) => a.category === 'free' || a.category === 'vip')).toHaveLength(0);
  });

  it('presets are cached: a second call within the TTL does not refetch', async () => {
    const spy = vi.mocked(fetch as any);
    await avatarService.getAvatarLibrary();
    const callsAfterFirst = spy.mock.calls.length;
    await avatarService.getAvatarLibrary();
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });
});
