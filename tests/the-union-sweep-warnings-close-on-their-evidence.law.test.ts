/**
 * THE UNION SWEEP WARNINGS CLOSE ON THEIR EVIDENCE (2026-10-17)
 *
 * fn_union_integrity_sweep_all keeps one open out_of_time warning per union
 * for the open-week rake basis snapshot, and nothing closed it when a refresh
 * landed again. The sweep now resolves it beside the refresh that ended it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017121603_the_union_sweep_warnings_close_on_their_evidence.sql',
  'utf8'
);
const newPassage = sql.slice(
  sql.indexOf('c_new constant text := $new$'),
  sql.indexOf('$new$;', sql.indexOf('c_new constant text := $new$'))
);

describe('the union sweep warnings close on their evidence', () => {
  it('closes the out_of_time warning only beside a refresh that landed, for its own union', () => {
    expect(newPassage).toContain("ELSIF COALESCE((v_rb->>'success')::boolean, false) THEN");
    expect(newPassage).toContain("a.source = 'fn_union_rake_basis_refresh'");
    expect(newPassage).toContain("a.context->>'kind' = 'out_of_time'");
    expect(newPassage).toContain("a.context->>'union_id' = u.id::text");
    // The skipped branch (windows in progress) never closes it.
    expect(newPassage.indexOf('UPDATE financial_alerts')).toBeGreaterThan(
      newPassage.indexOf('v_rb_refreshed := v_rb_refreshed + 1;')
    );
  });

  it('installs only over the pinned preimage and reads back the derived postimage', () => {
    expect(sql).toContain("'729a5617801d0038b1fa3c10f488c0bb'");
    expect(sql).toContain("'12861fc647dd2b033ecc875f7b5fa3f7'");
    expect(sql).toContain('pg_get_functiondef(v_oid) IS DISTINCT FROM v_new');
  });

  it('closes the 739-signal integrity alert only on its asserted evidence', () => {
    expect(sql).toContain("a.id = 'cc0387d7-e38f-4200-b0ab-d5cae4ab10d9'");
    expect(sql).toContain('<> 1903 THEN');
    expect(sql).toContain('IF v_n <> 1 THEN');
  });
});
