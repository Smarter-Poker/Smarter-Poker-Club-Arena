import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260926165200_opening_checklist_server_proves_its_boundary.sql'
  ),
  'utf8'
);

describe('the opening checklist server owns eligibility, finality and completion', () => {
  it('uses one standalone-new-club boundary for reads, skips and completion', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_club_opening_checklist_eligible');
    expect(sql.match(/fn_club_opening_checklist_eligible\(p_club_id\)/g)?.length).toBe(3);
    expect(sql).toContain('c.opening_checklist_started_at IS NOT NULL');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM public.union_clubs');
  });

  it('refuses every skip after the permanent latch', () => {
    expect(sql).toMatch(/FOR UPDATE;[\s\S]*v_row\.completed_at IS NOT NULL[\s\S]*Already Complete/);
    expect(sql).toContain('WHERE k.completed_at IS NULL');
  });

  it('derives every unskipped optional step from authoritative club data', () => {
    for (const id of [
      'identity',
      'tagline',
      'nlh',
      'plo',
      'limit',
      'mtt',
      'spin',
      'heads-up',
      'first-player',
      'first-agent',
    ])
      expect(sql).toContain(`'${id}' = ANY(v_skipped)`);
    expect(sql).toContain('public.club_opening_setups');
    expect(sql).toContain('cardinality(v_unfinished) > 0');
    expect(sql).toContain('Finish Or Skip Every Opening Checklist Step');
  });
});
