import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const VERSION = '20261005111546';
const FILE = `${VERSION}_union_period_records_belong_to_their_union_overseers.sql`;
const SQL = readFileSync(resolve(ROOT, 'supabase/migrations', FILE), 'utf8');

function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, (comment) => ' '.repeat(comment.length));
}

describe('union period records belong to their union overseers', () => {
  it('adds only the exact aggregate-row SELECT policy', () => {
    expect(SQL).toContain('CREATE POLICY union_settlement_period_read');
    expect(SQL).toMatch(
      /ON public\.settlement_periods\s+FOR SELECT\s+TO authenticated\s+USING \(\s*club_id IS NULL\s+AND union_id IS NOT NULL\s+AND public\.ca_can_oversee_union\(union_id\)\s*\)/
    );
    expect(SQL).not.toMatch(/FOR (?:INSERT|UPDATE|DELETE|ALL)/);
    expect(SQL).not.toContain('DROP POLICY IF EXISTS settlement_read');
    expect(SQL).not.toContain('DROP POLICY IF EXISTS union_overseer_read');
  });

  it('closes the retired SECURITY DEFINER browser entry while retaining service role', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.generate_period_settlements\(uuid\)\s+FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.generate_period_settlements\(uuid\)\s+TO service_role;/
    );
    expect(SQL).toContain("has_function_privilege(\n       'anon'");
    expect(SQL).toContain("has_function_privilege(\n       'authenticated'");
    expect(SQL).toContain("has_function_privilege(\n       'service_role'");
  });

  it('asserts its catalog postimage and exposes both live proofs', () => {
    expect(SQL).toContain("p.polname = 'union_settlement_period_read'");
    expect(SQL).toContain("v_command <> 'r'");
    expect(SQL).toContain('v_roles IS DISTINCT FROM ARRAY[v_authenticated]::oid[]');
    expect(SQL).toContain("position('ca_can_oversee_union' IN v_qual) = 0");
    expect(SQL).not.toContain("position('fn_is_union_overseer' IN v_qual)");
    expect(SQL.match(/^-- @live-proof:/gm)).toHaveLength(2);
  });

  it('no later migration silently reopens the RPC or removes the policy', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(resolve(ROOT, 'supabase/migrations')).sort()) {
      if (!file.endsWith('.sql') || file.slice(0, 14) <= VERSION) continue;
      const later = code(readFileSync(resolve(ROOT, 'supabase/migrations', file), 'utf8'));
      if (
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.generate_period_settlements\s*\(\s*uuid\s*\)\s+TO\s+(?:PUBLIC|anon|authenticated)/i.test(
          later
        )
      ) {
        offenders.push(`${file}: reopens generate_period_settlements to a browser role`);
      }
      if (/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?union_settlement_period_read\b/i.test(later)) {
        offenders.push(`${file}: removes union_settlement_period_read`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
