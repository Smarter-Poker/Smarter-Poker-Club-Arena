import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
import { resolveClubIdFilter } from '../../src/utils/clubIdResolver';
const read = (path: string) => readFileSync(path, 'utf8');
describe('Kings Club identity and branding', () => {
  it.each(['shark-club', 'kings-club', 'KINGS-CLUB'])('keeps %s on the existing club', (slug) => {
    expect(resolveClubIdFilter(slug)).toEqual({
      column: 'id',
      value: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
    });
    expect(resolveClubIdFilter('25450')).toEqual({ column: 'club_id', value: 25450 });
  });
  it('ships the exact supplied owner logo', () => {
    expect(
      createHash('sha256').update(readFileSync('public/images/kings-club-logo.png')).digest('hex')
    ).toBe('7d091e20aa201c2416de35550990cc1403fddbd18a78fcfaec8a494c93131663');
  });
  it('uses the current logo in every built-in club identity surface', () => {
    for (const file of [
      'src/components/home/CarouselSection.tsx',
      'src/pages/ClubHomePage.tsx',
      'src/pages/InvitePage.tsx',
      'src/pages/dev/ArenaGameCardsShowcasePage.tsx',
    ]) {
      expect(read(file)).toContain('images/kings-club-logo.png');
      expect(read(file)).not.toContain('images/shark-club-card.jpg');
    }
    expect(read('src/pages/HomePage.tsx')).toContain("name: 'Kings Club'");
    expect(read('src/App.tsx')).toContain('${location.search}${location.hash}');
  });
  it('renames both authoritative identities with preimage guards and leaves money untouched', () => {
    const sql = read('supabase/migrations/20261021180210_rename_shark_club_to_kings_club.sql');
    expect(sql).toContain("slug = 'kings-club'");
    expect(sql).toContain('kings_club_branding_preimage_changed');
    expect(sql).toContain('kings_social_branding_preimage_changed');
    expect(sql).not.toMatch(/UPDATE public\.(?:club_members|wallets|chip_ledger)/);
  });
});
