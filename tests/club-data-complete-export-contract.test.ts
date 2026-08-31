import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831144500_club_data_complete_export_jobs.sql'),
  'utf8'
);
const page = readFileSync(resolve(__dirname, '../src/pages/club/ClubDataPage.tsx'), 'utf8');
const helper = readFileSync(resolve(__dirname, '../src/utils/clubDataExport.ts'), 'utf8');

describe('Club Data complete export contract', () => {
  it('stores immutable ordered rows behind short-lived operator-owned jobs', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.ca_club_data_exports');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.ca_club_data_export_rows');
    expect(migration).toContain(
      "expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')"
    );
    expect(migration).toContain('UNIQUE (user_id, request_id)');
    expect(migration).toContain('PRIMARY KEY (export_id, ordinal)');
    expect(migration).toContain('ON DELETE CASCADE');
  });

  it('keeps direct rows private and repeats financial authorization on reads', () => {
    expect(migration).toContain(
      'ALTER TABLE public.ca_club_data_exports ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.ca_club_data_export_rows FROM PUBLIC, anon, authenticated'
    );
    expect(migration.match(/NOT public\.ca_can_view_club_finances/g)).toHaveLength(3);
    expect(migration).toContain("RAISE EXCEPTION 'export not found or no longer authorized'");
  });

  it('provides idempotent start, bounded paging, cancellation, and expiry cleanup', () => {
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('WHERE expires_at < now()');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.ca_club_data_export_page');
    expect(migration).toContain('LEAST(COALESCE(p_limit,1000),2000)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.ca_club_data_export_cancel');
    expect(migration).toContain('TO authenticated,service_role');
  });

  it('preserves the visible game and player ordering/filter choices', () => {
    for (const field of ['p_game', 'p_stakes', 'p_search', 'p_sort']) {
      expect(page).toContain(field);
    }
    expect(migration).toContain("v_sort NOT IN ('recent','fee','winnings','hands')");
    expect(migration).toContain("v_sort NOT IN ('winners','losers','rake','hands')");
    expect(migration).toContain("OR r.creator_name ILIKE '%'||v_search||'%'");
  });

  it('never hands a caller a short or duplicate file', () => {
    expect(helper).toContain('rows.length !== total || offset !== total');
    expect(helper).toContain('seen.has(key)');
    expect(helper).toContain("options.rpc('ca_club_data_export_cancel'");
    expect(page).toContain('No partial file was downloaded');
  });
});
