/**
 * A CACHED CLUB CARRIES A CACHED MEMBER COUNT.
 *
 * setClubHomeCache stores the whole club object, and the club object has
 * member_count on it. Every entry written before the member-count fix
 * (2026-08-25) holds an RLS-FILTERED number - 0 for someone who had not joined
 * the club, 593 for a union admin whose true total was 1,172 - and
 * CLUB_HOME_CACHE_TTL_MS is SEVEN DAYS.
 *
 * Without a version bump those wrong numbers keep painting on mount for a week
 * after the fix ships. They self-correct when the RPC answers, which is not
 * sufficient: if that request drops mid-flight the await site sees
 * `data == null`, declines to overwrite, and the stale number stays for the
 * whole visit.
 *
 * This test pins the two properties that make the transition safe, so a future
 * change to the cached shape cannot silently reintroduce a stale-count window.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(resolve(__dirname, '../src/pages/ClubHomePage.tsx'), 'utf8');

describe('the club-home cache cannot serve a pre-fix member count', () => {
  it('is at v3 or later — v2 is the poisoned generation', () => {
    const m = SRC.match(/const CLUB_HOME_CACHE_VER = '(v\d+)';/);
    expect(m, 'CLUB_HOME_CACHE_VER must exist and be a vN literal').not.toBeNull();
    const version = Number(m![1].slice(1));
    expect(version).toBeGreaterThanOrEqual(3);
  });

  it('the read key is versioned, so a bump actually orphans the old entries', () => {
    // If the read ever stops interpolating the version, bumping it does nothing
    // and this whole mechanism becomes decorative.
    expect(SRC).toMatch(
      /localStorage\.getItem\(`\$\{CLUB_HOME_CACHE_PREFIX\}\$\{CLUB_HOME_CACHE_VER\}_\$\{clubId\}`\)/
    );
  });

  it('the write key is versioned too, or reads and writes drift apart', () => {
    expect(SRC).toMatch(
      /const key = `\$\{CLUB_HOME_CACHE_PREFIX\}\$\{CLUB_HOME_CACHE_VER\}_\$\{clubId\}`/
    );
  });

  it('still takes the live count from the SECURITY DEFINER RPC, not the table', () => {
    // The cache bump is only worth anything if the value that replaces the
    // stale one is itself correct.
    expect(SRC).toMatch(/rpc\('fn_get_club_realtime_member_count'/);
    expect(SRC).not.toMatch(
      /from\('club_members'\)[\s\S]{0,200}?count: 'exact'[\s\S]{0,200}?eq\('club_id'/
    );
  });
});
