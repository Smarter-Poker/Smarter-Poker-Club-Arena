import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const old = read('supabase/migrations/20261007041535_two_owner_screens_read_what_they_show.sql');
const migration = read(
  'supabase/migrations/20261010011934_cashier_totals_count_directional_ranges_without_rescanning.sql'
);
const definition = (sql: string) => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(');
  return sql.slice(start, sql.indexOf('$function$;', start) + '$function$;'.length);
};

describe('Cashier default totals preserve their independent read paths', () => {
  it('changes only the guarded default/all aggregate and leaves every fallback byte intact', () => {
    const candidate = definition(migration);
    const start = candidate.indexOf("  IF v_totals_only AND p_scope='all' AND v_wallet IS NULL");
    const end = candidate.indexOf('  RETURN QUERY EXECUTE v_sql', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(candidate.slice(0, start) + candidate.slice(end)).toBe(definition(old));
  });

  it('keeps online index construction outside the guarded recording transaction', () => {
    const online = read('scripts/ops/build-cashier-direction-totals-index-concurrently.sql');
    expect(online).toMatch(/^CREATE INDEX CONCURRENTLY idx_chip_ledger_cashier_direction_totals/m);
    expect(online).not.toMatch(/^BEGIN;/m);
    expect(migration).not.toMatch(/CREATE INDEX/i);
    expect(migration).toContain("SET LOCAL lock_timeout = '2s'");
    expect(migration).toContain('cashier_source_preimage_changed');
    expect(migration).toContain('cashier_direction_cover_shape_changed');
    expect(migration).toContain("to_jsonb(p)-'prosrc'");
  });
});
