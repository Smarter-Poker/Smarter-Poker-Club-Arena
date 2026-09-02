import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { hasNewClubOpeningChecklist } from '../../src/utils/clubOpeningEligibility';

describe('new club opening eligibility', () => {
  it('shows the checklist only for newly created standalone clubs', () => {
    expect(
      hasNewClubOpeningChecklist({ opening_checklist_started_at: '2026-09-01T13:30:00Z' })
    ).toBe(true);
    expect(hasNewClubOpeningChecklist({})).toBe(false);
    expect(
      hasNewClubOpeningChecklist({
        opening_checklist_started_at: '2026-09-01T13:30:00Z',
        is_union: true,
      })
    ).toBe(false);
    expect(
      hasNewClubOpeningChecklist({
        opening_checklist_started_at: '2026-09-01T13:30:00Z',
        union_id: 'union-id',
      })
    ).toBe(false);
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
