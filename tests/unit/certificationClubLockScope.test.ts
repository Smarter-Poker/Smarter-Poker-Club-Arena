import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261029193107_certification_cleanup_locks_only_its_own_club_graph.sql',
  'utf8'
);
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
describe('certification cleanup isolates its club from live hand saves', () => {
  it('keeps shared maintenance admission and refuses busy club ownership immediately', () => {
    const helper = migration.split('AS $admission$')[1].split('$admission$')[0];
    expect(helper).toContain('pg_try_advisory_xact_lock_shared(530090,1)');
    expect(helper).toContain('FROM public.clubs WHERE id=p_club_id FOR UPDATE NOWAIT');
    expect(helper).not.toMatch(/pg_sleep|pg_advisory_xact_lock\(/);
    expect(migration).toContain('FROM PUBLIC,anon,authenticated,service_role');
  });
  it('pins all four complete catalog preimages and preserves access', () => {
    expect(migration.match(/^ {4}\('public\.fn_ca_prepare_/gm)).toHaveLength(4);
    expect(migration).toContain('md5(before_text)<>item.pre_hash');
    expect(migration).toContain('pg_get_functiondef(signature)<>after_text');
    expect(migration).toContain('IS DISTINCT FROM prior_acl');
    expect(migration).toContain("after_text:=replace(before_text,old_gate,'')");
    expect(migration).toMatch(/^-- @live-proof:/m);
  });
  it('protects both non-FK game stores from deleted-parent races without changing other branches', () => {
    const addition = migration.split('addition text := $missing$')[1].split('$missing$')[0];
    expect(addition).toContain("TG_OP <> 'DELETE'");
    expect(addition).toContain("TG_TABLE_NAME IN ('cash_games','tournament_schedules')");
    expect(addition).toContain('NOT EXISTS (SELECT 1 FROM public.clubs WHERE id=v_club_id)');
    expect(addition).toContain("ERRCODE='23503'");
    expect(migration).toContain("replace(after_text,addition,'')<>before_text");
  });
  it('enforces both native concurrency and full business qualification in existing CI', () => {
    expect(workflow).toContain('python3 -B scripts/ci/test-certification-club-lock-scope.py');
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-club-welcome-package.py --certification-club-scope'
    );
    const native = readFileSync('scripts/ci/test-certification-club-lock-scope.py', 'utf8');
    expect(native).toContain('sql(MIGRATION.read_text())');
    expect(native).toContain('BEFORE exact cleanup gate times out a live continuation');
    expect(native).toContain('waiting writer refuses deleted parent:');
    expect(native).toContain('cluster_removed');
  });
});
