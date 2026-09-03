import { describe, expect, it } from 'vitest';
import {
  chunkSocialProfileIds,
  formatSocialLastSeen,
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

  it('accepts realtime presence immediately and persisted presence only while fresh', () => {
    const now = Date.parse('2026-08-30T12:00:00.000Z');
    expect(isSocialProfileOnline('a', new Set(['a']), false, undefined, now)).toBe(true);
    expect(isSocialProfileOnline('b', new Set(), true, '2026-08-30T11:57:00.000Z', now)).toBe(true);
    expect(isSocialProfileOnline('b', new Set(), true, '2026-08-30T11:40:00.000Z', now)).toBe(
      false
    );
  });

  it('formats useful recent activity without exposing old timestamps forever', () => {
    const now = Date.parse('2026-08-30T12:00:00.000Z');
    expect(formatSocialLastSeen('2026-08-30T11:43:00.000Z', now)).toBe('Active 17m ago');
    expect(formatSocialLastSeen('2026-08-28T12:00:00.000Z', now)).toBe('Active 2d ago');
    expect(formatSocialLastSeen('2026-06-01T12:00:00.000Z', now)).toBe('Offline');
  });

  it('chunks profile lookups so large networks do not create oversized URLs', () => {
    const ids = Array.from({ length: 251 }, (_, index) => String(index));
    expect(chunkSocialProfileIds(ids, 100).map((chunk) => chunk.length)).toEqual([100, 100, 51]);
  });
});
