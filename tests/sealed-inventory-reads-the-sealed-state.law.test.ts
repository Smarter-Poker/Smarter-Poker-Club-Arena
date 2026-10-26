import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
const name = '20261026224626_sealed_inventory_reads_the_sealed_state_directly.sql';
const migration = readFileSync(resolve('supabase/migrations/' + name), 'utf8');
describe('A sealed inventory boundary reads its original sealed state', () => {
  it('retains rows and issues and leaves the original delta path intact', () => {
    expect(migration).toContain('IF p_base=p_at THEN');
    expect(migration).toContain(
      'FROM public.union_pnl_inventory_published_rows r WHERE r.boundary=p_base'
    );
    expect(migration).toContain(
      'FROM public.union_pnl_inventory_published_issues i WHERE i.boundary=p_base'
    );
    expect(migration).toContain("anchor:=E' RETURN QUERY\\n WITH d AS MATERIALIZED ('");
    expect(migration).toContain('sealed_inventory_reader_original_sources_changed');
    expect(migration).toContain('sealed_inventory_reader_source_authority_failed');
  });
  it('runs the captured original financial qualification against this exact migration', () => {
    const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('--inventory-state-read-migration supabase/migrations/' + name);
    const wrapper = readFileSync(
      resolve('scripts/qualification/original-retirement-boundary/run-wrapper-native.py'),
      'utf8'
    );
    expect(wrapper).toContain('ORB_INVENTORY_STATE_READ_MIGRATION');
    expect(wrapper).toContain('originalrawfiniteactiveprojection differs');
    expect(wrapper).toContain('full245wrapper admission differs');
  });
});
