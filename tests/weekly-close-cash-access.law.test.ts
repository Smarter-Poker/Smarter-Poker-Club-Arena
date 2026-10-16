import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path: string) => readFileSync(path, 'utf8');
const root = 'scripts/ci/fixtures/weekly-cash-access';
const pins = JSON.parse(read(`${root}/replacement.json`));
const migration = read(
  'supabase/migrations/20261016200904_weekly_cash_close_uses_club_coordinator_time_index.sql'
);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('weekly close cash equality and unaccrued access paths', () => {
  it('changes only three exact commission reader fragments', () => {
    const before = read(`${root}/commission-before.sql`);
    let after = before;
    for (const [index, [old, next]] of pins.replacements.entries()) {
      expect(after.split(old)).toHaveLength(2);
      expect(migration).toContain(`$old${index}$${old}$old${index}$`);
      expect(migration).toContain(`$new${index}$${next}$new${index}$`);
      after = after.replace(old, next);
    }
    expect(md5(before)).toBe(pins.before);
    expect(after).toBe(read(`${root}/commission-after.sql`));
    expect(md5(after)).toBe(pins.after);
    expect(migration).toContain(pins.before);
    expect(migration).toContain(pins.after);
    expect(read('scripts/ci/fixtures/inventory-proof-lifetime-sources.json')).not.toContain(
      'fn_assert_cash_commission_period('
    );
  });

  it('keeps the complete club reader unchanged and supplies its exact lookup order', () => {
    const helper = read(`${root}/helper-current.sql`);
    expect(md5(helper)).toBe('2d861ca48eea9aba964cda9b4d45f456');
    expect(helper).toContain(read(`${root}/cash-query.sql`).trim());
    expect(migration).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_rake_sources_club_coordinator_earned\n ON public.accounting_cash_rake_sources (club_id,coordinator_union_id,earned_at);'
    );
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
    for (const guard of [
      'operator_refused',
      'freeze_or_override_refused',
      'scheduler_owned',
      'history_replay',
      'exact_index_required',
      'partial_index_required',
      'rake_identity_required',
      'preimage_authority_refused',
      'exact_replacement_refused',
      'postimage_refused',
      'installed_source_refused',
    ])
      expect(migration).toContain(`weekly_cash_access_${guard}`);
    expect(migration).not.toMatch(
      /UPDATE\s+(?:public\.)?(?:chip_ledger|club_members|ca_settlements)|ALTER FUNCTION/i
    );
  });

  it('runs actual PostgreSQL access, eligibility and installation proof in required accounting', () => {
    const parent = read('scripts/ci/test_launch_reset_floor.py');
    for (const name of [
      'test-weekly-cash-keyorder-postgres.py',
      'test-weekly-cash-commission-postgres.py',
      'test-weekly-cash-access-install-postgres.py',
    ])
      expect(parent).toContain(`'${name}'`);
    expect(read('scripts/ci/test-weekly-cash-keyorder-postgres.py')).toContain(
      'all_cash_maxima_match_independent_grouped_oracle'
    );
    expect(read('scripts/ci/test-weekly-cash-commission-postgres.py')).toContain(
      'mixed_scale_only_one_unaccrued_heap_lookup'
    );
  });
});
