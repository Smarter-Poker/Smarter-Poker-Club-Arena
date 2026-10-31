import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(p, 'utf8');
describe('runtime privileges preserve schema boundaries', () => {
  it('changes only authoritative GRANT/REVOKE classification', () => {
    const original = read('scripts/ci/fixtures/runtime-privileges/original-event-guard.sql')
      .trim()
      .replace(/\s*;$/, ';');
    const sql = read(
      'supabase/migrations/20261027165306_privilege_changes_do_not_reload_the_schema.sql'
    );
    const body = sql
      .slice(
        sql.indexOf('CREATE OR REPLACE FUNCTION'),
        sql.indexOf('$function$;', sql.indexOf('CREATE OR REPLACE FUNCTION')) + 11
      )
      .trim();
    const start = body.indexOf('    -- GRANT/REVOKE change privileges');
    const end = body.indexOf("    IF TG_EVENT = 'sql_drop' THEN", start);
    expect(body.slice(0, start) + body.slice(end)).toBe(original);
    expect(body.slice(start, end)).toContain(
      "TG_EVENT='ddl_command_end' AND TG_TAG IN('GRANT','REVOKE')"
    );
    expect(sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION'))).not.toContain(
      'SET LOCAL ca.break_window_migration_override'
    );
  });
  it('runs real event-trigger and original reserve regression on one accounting shard', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 -B scripts/ci/test-runtime-privilege-ddl-guard-postgres.py'
    );
    expect(read('scripts/ci/test-runtime-privilege-ddl-guard-postgres.py')).toContain(
      'actual-original-event-guard-refuses-actual-reserve-temp-REVOKE'
    );
  });
});
