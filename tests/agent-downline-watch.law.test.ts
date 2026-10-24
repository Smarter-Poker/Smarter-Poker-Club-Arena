import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const migration = migrationCorpus()
  .filter(({ sql }) => /CREATE OR REPLACE FUNCTION public\.fn_agent_can_watch_table\(/.test(sql))
  .at(-1)!;

describe('agents can observe every live downline table', () => {
  it('authenticates the viewer and uses active, cycle-safe recursive relationships', () => {
    expect(migration.sql).toContain('auth.uid() IS DISTINCT FROM p_viewer_user_id');
    expect(migration.sql).toContain("coalesce(auth.role(), '') <> 'service_role'");
    expect(migration.sql).toContain("cm.role IN ('super_agent', 'agent', 'sub_agent')");
    expect(migration.sql).toContain(
      'child.club_id = parent.club_id AND child.agent_id = parent.user_id'
    );
    expect(migration.sql).toContain("child.status IN ('active', 'approved')");
    const helper = migration.sql.split('$watch_agent$')[1];
    expect(helper).toContain('UNION\n      SELECT child.club_id');
    expect(helper).not.toMatch(/depth\s*</);
    expect(helper).not.toMatch(/hole_cards|wallet|is_horse/);
  });

  it('connects metadata, search, click-time and engine gates to the same exception', () => {
    expect(migration.sql).toContain(
      'CREATE POLICY agent_downline_table_observation ON public.tables'
    );
    expect(migration.sql).toContain('-- @install-window: daily-maintenance');
    expect(migration.sql).toContain(
      'v_downline := public.fn_agent_can_watch_table(p_table_id, v_uid)'
    );
    expect(migration.sql).toContain('OR public.fn_agent_can_watch_table(live.table_id, v_uid)');
    const engine = readFileSync('server/src/services/TableViewerAccess.ts', 'utf8');
    expect(engine).toContain("supabase.rpc('fn_agent_can_watch_table'");
    expect(engine).toContain('p_viewer_user_id: userId');
    expect(engine.indexOf("reason: 'agent_downline'")).toBeLessThan(
      engine.indexOf("arena.kind === 'diamond_arena'")
    );
  });

  it('runs native PostgreSQL authorization and RLS cases in existing required CI', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('python3 scripts/ci/test-player-search-privacy-postgres.py');
    const native = readFileSync('scripts/ci/test-player-search-privacy-postgres.py', 'utf8');
    expect(native).toContain(migration.name);
    expect(native).toContain("FIXTURE / 'downline-watch.sql'");
    expect(native).toContain('baseline-confirmed-active-recursive-agent-refused');
  });
});
