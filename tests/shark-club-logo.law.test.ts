import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan 2026-10-16: Shark Club wears its new logo everywhere it should,
// including its club social page.
const LOGO = 'public/images/shark-club-logo-v2.png';
const URL = '/hub/club-arena/images/shark-club-logo-v2.png';
const migration = readFileSync(
  'supabase/migrations/20261016223411_the_shark_club_wears_its_new_logo.sql',
  'utf8'
);

describe('the Shark Club logo', () => {
  it('ships as a PNG asset', () => {
    expect(existsSync(LOGO)).toBe(true);
    expect(readFileSync(LOGO).subarray(1, 4).toString()).toBe('PNG');
  });

  it('is what the club row and its social page name, changed only from the observed values', () => {
    expect(migration.split('\n')[0]).toMatch(/^-- @live-proof: /);
    expect(
      migration.match(new RegExp(URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g'))?.length
    ).toBeGreaterThanOrEqual(4);
    expect(migration).toContain('AND logo_url IS NULL;');
    expect(migration).toContain('shark_club_social_avatar_preimage_changed');
  });

  it('is the bundled fallback wherever Shark Club had the old emblem', () => {
    for (const file of [
      'src/pages/ClubHomePage.tsx',
      'src/pages/InvitePage.tsx',
      'src/pages/dev/ArenaGameCardsShowcasePage.tsx',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain('images/shark-club-logo-v2.png');
      expect(src, file).not.toMatch(/images\/shark-club-logo\.jpg`/);
    }
  });
});
