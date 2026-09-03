import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260831z_player_command_lifetime_fee_totals.sql'),
  'utf8'
);

describe('Player Command lifetime fee projection', () => {
  it('replaces the per-request daily fee fan-out with one row per player', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.member_fee_lifetime');
    expect(migration).toContain('FROM public.member_fee_lifetime r');
    expect(migration).toContain('roster fee CTE was not found exactly once');
  });

  it('keeps the projection synchronized for inserts, updates and deletes', () => {
    expect(migration).toContain('REFERENCING NEW TABLE AS inserted_member_fees');
    expect(migration).toContain(
      'REFERENCING OLD TABLE AS previous_member_fees NEW TABLE AS updated_member_fees'
    );
    expect(migration).toContain('REFERENCING OLD TABLE AS deleted_member_fees');
    expect(migration).toContain('lifetime.fees + EXCLUDED.fees');
    expect(migration).toContain('lifetime.hands + EXCLUDED.hands');
  });

  it('locks the source during backfill and proves exact parity before commit', () => {
    expect(migration).toContain('LOCK TABLE public.member_fee_rollup IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain('FULL JOIN public.member_fee_lifetime lifetime USING (user_id)');
    expect(migration).toContain('IS DISTINCT FROM lifetime.fees');
    expect(migration).toContain('IS DISTINCT FROM lifetime.hands');
  });

  it('does not expose the internal projection or its trigger functions to browsers', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.member_fee_lifetime FROM PUBLIC, anon, authenticated'
    );
    expect(migration.match(/REVOKE ALL ON FUNCTION public\.fn_member_fee_lifetime_/g)).toHaveLength(
      3
    );
    expect(migration).not.toMatch(/GRANT[^;]+authenticated/i);
  });
});
