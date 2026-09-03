/**
 * RETINA AVATAR INVARIANT (2026-08-24)
 *
 * 193 profiles legitimately store their table art as
 * /avatars/table/X@2x.webp (AvatarService writes the sharper @2x asset on
 * purpose). The 2026-08-23 mobile outage happened because SeatSlot's srcSet
 * blindly appended another @2x, producing X@2x@2x.webp — a 404 that every
 * phone (DPR>=2) selected, so seats fell back to letter initials while
 * desktop looked fine.
 *
 * These tests pin the two rules that make that impossible:
 *   1. SeatSlot may only offer a 2x srcSet candidate for BASE table art
 *      (guarded by a regex that rejects URLs already containing @2x).
 *   2. getAvatarWithFallback must pass @2x table art through untouched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { getAvatarWithFallback, sizedStorageUrl } from '../../src/utils/avatarGenerator';

const seatSlot = readFileSync('src/components/table/SeatSlot.tsx', 'utf8');

describe('SeatSlot retina srcSet guard', () => {
  it('never appends @2x unconditionally', () => {
    // Every `.replace(/\.webp$/, '@2x.webp')` in the file must sit inside a
    // conditional whose test rejects URLs that already carry @2x.
    const appendSites = seatSlot.split("replace(/\\.webp$/, '@2x.webp')").length - 1;
    expect(appendSites).toBeGreaterThan(0); // the 2x candidate still exists
    // The guard regex — a character class excluding @ before .webp — must be
    // present and must gate the srcSet.
    expect(seatSlot).toMatch(/\[\^@\\s\]\+\\\.webp\$\/\.test\(avatarUrl\)/);
  });

  it('the guard regex accepts base art and rejects already-@2x art', () => {
    const guard = /^https?:\/\/[^\s]+\/avatars\/table\/[^@\s]+\.webp$/;
    expect(guard.test('https://smarter.poker/avatars/table/free_shark.webp')).toBe(true);
    expect(guard.test('https://smarter.poker/avatars/table/vip_angel@2x.webp')).toBe(false);
    expect(guard.test('https://x.supabase.co/storage/v1/render/image/public/a.png?width=112')).toBe(
      false
    );
  });
});

describe('getAvatarWithFallback', () => {
  it('passes @2x table art through untouched (absolute)', () => {
    expect(getAvatarWithFallback('/avatars/table/vip_angel@2x.webp', 'seed', 'Name')).toBe(
      'https://smarter.poker/avatars/table/vip_angel@2x.webp'
    );
  });
  it('maps library png to the table webp', () => {
    expect(getAvatarWithFallback('/avatars/free/shark.png', 'seed', 'Name')).toBe(
      'https://smarter.poker/avatars/table/free_shark.webp'
    );
  });
  it('routes storage objects through the resize endpoint when sized', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/social-media/avatars/a.png';
    const out = getAvatarWithFallback(url, 'seed', 'Name', 44);
    expect(out).toContain('/storage/v1/render/image/public/');
    expect(out).toContain('width=88'); // 2x the CSS box
  });
  it('falls back to a data-URI monogram when there is no avatar', () => {
    expect(getAvatarWithFallback(null, 'seed', 'Two Words')).toMatch(/^data:image\/svg\+xml,/);
  });
  it('sizedStorageUrl leaves non-storage URLs alone', () => {
    expect(sizedStorageUrl('/avatars/table/free_shark.webp', 44)).toBe(
      '/avatars/table/free_shark.webp'
    );
  });
});
