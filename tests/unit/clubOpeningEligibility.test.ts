import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  hasNewClubOpeningChecklist,
  hasOwnClubPicture,
  isPresetClubLogo,
  resolveClubLaunchTasks,
  resolveClubUnionScope,
} from '../../src/utils/clubOpeningEligibility';

describe('new club opening eligibility', () => {
  it('shows the checklist only for newly created standalone clubs', () => {
    expect(
      hasNewClubOpeningChecklist({ opening_checklist_started_at: '2026-09-01T13:30:00Z' }, null)
    ).toBe(true);
    expect(hasNewClubOpeningChecklist({}, null)).toBe(false);
    expect(
      hasNewClubOpeningChecklist(
        {
          opening_checklist_started_at: '2026-09-01T13:30:00Z',
          is_union: true,
        },
        null
      )
    ).toBe(false);
    expect(
      hasNewClubOpeningChecklist(
        {
          opening_checklist_started_at: '2026-09-01T13:30:00Z',
          union_id: 'union-id',
        },
        'union-id'
      )
    ).toBe(false);
  });

  it('fails closed until union scope is resolved and excludes union_clubs-only members', () => {
    const club = { opening_checklist_started_at: '2026-09-01T13:30:00Z' };

    expect(hasNewClubOpeningChecklist(club, undefined)).toBe(false);
    expect(hasNewClubOpeningChecklist(club, 'union-from-membership-table')).toBe(false);
    expect(hasNewClubOpeningChecklist(club, null)).toBe(true);
  });

  it('marks future inserts without backfilling any existing club or union', () => {
    const migration = readFileSync(
      resolve(__dirname, '../../supabase/migrations/20260902070000_new_club_checklist_scope.sql'),
      'utf8'
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS opening_checklist_started_at');
    expect(migration).toContain('BEFORE INSERT ON public.clubs');
    expect(migration).not.toMatch(/UPDATE\s+public\.clubs/i);
  });
});

describe('club union scope for create controls', () => {
  it('is standalone only on a positive answer from every source', () => {
    expect(resolveClubUnionScope({ is_union: false, union_id: null }, null)).toBe('standalone');
    expect(resolveClubUnionScope({}, null)).toBe('standalone');
  });

  it('fails closed while the union lookup is unresolved or errored', () => {
    /* `undefined` is both "still loading" and "the lookup errored with nothing
       to fall back on": the page never writes null on that path. */
    expect(resolveClubUnionScope({ is_union: false, union_id: null }, undefined)).toBe(
      'unresolved'
    );
    expect(resolveClubUnionScope(null, null)).toBe('unresolved');
    expect(resolveClubUnionScope(undefined, undefined)).toBe('unresolved');
  });

  it('names a union from any source, including a union_clubs-only link', () => {
    expect(resolveClubUnionScope({}, 'union-from-membership-table')).toBe('union');
    expect(resolveClubUnionScope({ union_id: 'u1' }, undefined)).toBe('union');
    expect(resolveClubUnionScope({ is_union: true }, null)).toBe('union');
  });
});

describe('club profile picture step', () => {
  it('treats every built-in placeholder crest as not the club own picture', () => {
    const modal = readFileSync(
      resolve(__dirname, '../../src/components/modals/CreateClubModal.tsx'),
      'utf8'
    );
    const presetFiles = [...modal.matchAll(/file: '(club-logos\/preset-\d+\.webp)'/g)].map(
      (match) => match[1]
    );
    expect(presetFiles).toHaveLength(10);
    for (const file of presetFiles) {
      expect(isPresetClubLogo(file)).toBe(true);
      expect(isPresetClubLogo(`/${file}`)).toBe(true);
      expect(isPresetClubLogo(`https://media.example.test/${file}?v=3`)).toBe(true);
    }
  });

  it('accepts a real upload, in either column', () => {
    const settingsUpload =
      'https://x.supabase.co/storage/v1/object/public/club-assets/club-logos/9f1c-1726800000000.png';
    const creationUpload =
      'https://x.supabase.co/storage/v1/object/public/club-assets/club-logos/user-1/request-1.webp';
    expect(isPresetClubLogo(settingsUpload)).toBe(false);
    expect(isPresetClubLogo(creationUpload)).toBe(false);
    expect(hasOwnClubPicture({ logo_url: settingsUpload })).toBe(true);
    expect(
      hasOwnClubPicture({ logo_url: 'club-logos/preset-19.webp', avatar_url: creationUpload })
    ).toBe(true);
  });

  it('is not done for a placeholder, an empty value or no club', () => {
    expect(hasOwnClubPicture({ logo_url: '/club-logos/preset-19.webp' })).toBe(false);
    expect(
      hasOwnClubPicture({
        logo_url: 'club-logos/preset-01.webp',
        avatar_url: '/club-logos/preset-04.webp',
      })
    ).toBe(false);
    expect(hasOwnClubPicture({ logo_url: '  ', avatar_url: null })).toBe(false);
    expect(hasOwnClubPicture(null)).toBe(false);
    expect(isPresetClubLogo('club-logos/preset-custom.webp')).toBe(false);
  });
});

describe('opening checklist skip resolution', () => {
  it('skips only optional, unfinished steps', () => {
    const resolved = resolveClubLaunchTasks(
      [
        { id: 'opening-setup', complete: false },
        { id: 'identity', complete: false, optional: true },
        { id: 'tagline', complete: true, optional: true },
        { id: 'nlh', complete: false, optional: true },
      ],
      ['opening-setup', 'identity', 'tagline']
    );
    expect(resolved.map((task) => task.skipped)).toEqual([false, true, false, false]);
  });
});
