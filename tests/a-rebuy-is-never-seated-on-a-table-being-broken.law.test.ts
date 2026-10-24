/**
 * A REBUY IS NEVER SEATED ON A TABLE BEING BROKEN (2026-10-24)
 *
 * fn_ca_choose_tournament_seat_locked seats a rebuy at the table with the most
 * free chairs. A table whose F06 break is in progress is usually that table,
 * and f06_source_guard (correctly) refuses the write, so the rebuy rolled back
 * on every retry until its offer expired: 192 F06_SOURCE_EXCLUDED refusals in
 * four and a half hours. The chooser now ranks such a table last.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20261024193700_a_rebuy_is_never_seated_on_a_table_being_broken.sql'
  ),
  'utf8'
);
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('a rebuy is never seated on a table being broken', () => {
  it('is one transaction with a live proof', () => {
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(sql).toMatch(/^-- @live-proof: .*A REBUY IS NEVER SEATED ON A TABLE BEING BROKEN/m);
  });

  it('patches only the measured chooser body', () => {
    expect(code).toContain(
      "'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure"
    );
    expect(code).toMatch(/md5\(v_src\) <> '8a3849d04f1fa2d6a2e266e86527877e'/);
    expect(code).toContain("v_old := E'   ORDER BY (\\n       SELECT count(*)\\n';");
  });

  it('ranks a table with an F06 break in progress before every existing key', () => {
    const patch = sql.slice(sql.indexOf('$new$'), sql.lastIndexOf('$new$'));
    expect(patch).toMatch(
      /ORDER BY EXISTS \(\s*SELECT 1 FROM smarter_private\.f06_operations o\s*WHERE o\.source_table_id=tb\.id\s*AND o\.state NOT IN \('acknowledged','withdrawn_before_manifest'\)\),\s*\(\s*SELECT count\(\*\)/
    );
    // A ranking, never an exclusion: with no other legal chair it still seats.
    expect(patch).not.toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM smarter_private\.f06_operations/);
  });

  it('keeps the chooser private and security definer', () => {
    for (const role of ['service_role', 'authenticated', 'anon']) {
      expect(code).toContain(`NOT has_function_privilege('${role}', p.oid, 'EXECUTE')`);
    }
    expect(code).toContain(
      "p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]"
    );
  });
});
