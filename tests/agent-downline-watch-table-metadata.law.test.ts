import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION =
  'supabase/migrations/20261024200812_agent_downline_watch_reads_table_metadata.sql';

describe('an agent can open a downline table the arena policy hides', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('returns bootstrap columns only to a viewer the downline helper allows', () => {
    expect(sql).not.toContain('@install-window');
    expect(sql).not.toMatch(/^\s*(CREATE|ALTER|DROP) POLICY/m);
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('v_uid uuid := auth.uid();');
    expect(sql).toContain('public.fn_agent_can_watch_table(p_table_id, v_uid)');
    expect(sql).toContain('FROM PUBLIC, anon;');
    expect(sql).not.toMatch(/hole_cards|wallet|balance/);
  });

  it('is read by the TablePage bootstrap only after the direct read finds no row', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
    const loop = page.indexOf('if (!res.error && !table) break;');
    const rpc = page.indexOf("supabase.rpc('fn_agent_watch_table_metadata'");
    const missing = page.indexOf('THE DEAD-BOOKMARK HOLE', loop);
    expect(loop).toBeGreaterThan(0);
    expect(rpc).toBeGreaterThan(loop);
    expect(rpc).toBeLessThan(missing);
    expect(page).toContain('if (!table && !error && isMounted && tableId) {');
  });

  it('is proved against a restrictive policy in native PostgreSQL', () => {
    const native = readFileSync('scripts/ci/test-player-search-privacy-postgres.py', 'utf8');
    expect(native).toContain(MIGRATION.split('/').at(-1));
    expect(native).toContain('AS RESTRICTIVE');
    expect(native).toContain('agent-downline-watch-table-metadata-passed');
  });
});
