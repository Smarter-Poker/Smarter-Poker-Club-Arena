/**
 * THE WEEK'S TOURNAMENT CLUBS ARE READ FROM AN INDEX (2026-10-16).
 *
 * Pinned on migration 20261016152326_the_weeks_tournament_clubs_are_read_from_an_index.sql.
 *
 * fn_accounting_week_clubs reads the union's tournament clubs with SELECT
 * DISTINCT club_id ... WHERE coordinator_union_id = <union>. Without a
 * (coordinator_union_id, club_id) index every fee row came from the heap:
 * 86.8 s cold on the first call of each job 272 tick. Keep the index.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261016152326_the_weeks_tournament_clubs_are_read_from_an_index.sql'),
  'utf8'
);

describe("the week's tournament clubs are read from an index", () => {
  it('builds the index concurrently before one guarded transaction', () => {
    const create = sql.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_sources_coordinator_club');
    const begin = sql.indexOf('\nBEGIN;');
    expect(create).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(create);
    expect(sql).toContain('ON public.accounting_tournament_fee_sources (coordinator_union_id, club_id) WHERE coordinator_union_id IS NOT NULL;');
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('checks the index is valid and has the right shape, with a live proof', () => {
    expect(sql).toContain("cols IS DISTINCT FROM ARRAY['coordinator_union_id','club_id']::text[]");
    expect(sql).toContain('NOT ix.indisvalid');
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
  });
});
