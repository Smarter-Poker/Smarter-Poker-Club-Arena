import { describe, expect, it } from 'vitest';
import {
  chunkSocialProfileIds,
  isSocialProfileOnline,
  resolveSocialProfile,
} from '../../src/utils/socialGraph';

describe('social graph profile resolution', () => {
  it('uses the Club Arena handle contract before stale display names', () => {
    expect(
      resolveSocialProfile({
        id: 'player-1',
        alias: 'KingFish',
        username: 'kingfish',
        display_name: 'Stale Seed Name',
      })
    ).toMatchObject({ available: true, name: 'KingFish' });
  });

  it('keeps a missing profile visible without inventing an identity', () => {
    expect(resolveSocialProfile(null)).toEqual({
      available: false,
      name: 'Player Profile Unavailable',
      sourceOnline: false,
    });
  });

  it('accepts realtime presence immediately and otherwise the presence door, which is fresh by construction', () => {
    /* Since ruling 22 (2026-10-01) the browser never receives last_seen: the
       five-minute freshness test runs in fn_profile_presence, so the persisted
       answer passed here is already fresh, and a stale flag arrives as false. */
    expect(isSocialProfileOnline('a', new Set(['a']), false)).toBe(true);
    expect(isSocialProfileOnline('b', new Set(), true)).toBe(true);
    expect(isSocialProfileOnline('b', new Set(), false)).toBe(false);
  });

  it('never carries a last-seen time into the resolved profile', () => {
    const resolved = resolveSocialProfile({
      id: 'player-2',
      username: 'shark',
      is_online: true,
      last_seen: '2026-08-30T11:57:00.000Z',
    } as never);
    expect(resolved).toEqual({
      available: true,
      name: 'shark',
      avatarUrl: undefined,
      sourceOnline: true,
    });
  });

  it('chunks profile lookups so large networks do not create oversized URLs', () => {
    const ids = Array.from({ length: 251 }, (_, index) => String(index));
    expect(chunkSocialProfileIds(ids, 100).map((chunk) => chunk.length)).toEqual([100, 100, 51]);
  });
});
