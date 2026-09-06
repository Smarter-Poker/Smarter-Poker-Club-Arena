import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { hasNewClubOpeningChecklist } from '../../src/utils/clubOpeningEligibility';

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
