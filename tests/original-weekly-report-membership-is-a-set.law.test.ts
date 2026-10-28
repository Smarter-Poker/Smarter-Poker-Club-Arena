import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const base = 'scripts/qualification/original-retirement-boundary/membership-capacity/';
const migration =
  'supabase/migrations/20261028033359_original_weekly_report_reads_tournament_membership_as_a_set.sql';
const read = (path: string) => readFileSync(path, 'utf8');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const old = Object.fromEntries(
  ['report', 'advance', 'guard'].map((n) => [n, read(`${base}${n}-original.sql`)])
);
const next = Object.fromEntries(
  ['report', 'advance', 'guard'].map((n) => [n, read(`${base}${n}-candidate.sql`)])
);
describe('original report reads exact tournament membership as a set', () => {
  it('changes only one membership expression and its direct report hash caller', () => {
    expect(md5(old.report)).toBe('49b47361e2ccd195968d293b1bb7c3c0');
    expect(md5(old.advance)).toBe('736539c3d60fd047c352e127f18d54bb');
    expect(md5(old.guard)).toBe('edc8545a57d017a7cce79550dd0520f9');
    expect(next.report).toBe(
      old.report.replace(
        'public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)',
        () => read(`${base}membership-expression.sql`).trim()
      )
    );
    expect(next.advance).toBe(old.advance.replace(md5(old.report), md5(next.report)));
    expect(next.guard).toBe(
      old.guard
        .replace(md5(old.report), md5(next.report))
        .replace(md5(old.advance), md5(next.advance))
    );
    const pins = (s: string) =>
      new Map([...s.matchAll(/\('([^']+)','([a-f0-9]{32})'\)/g)].map((m) => [m[1], m[2]]));
    const a = pins(old.guard),
      b = pins(next.guard);
    expect(a.size).toBe(65);
    expect(b.size).toBe(65);
    expect([...a].filter(([k, v]) => b.get(k) !== v).length).toBe(2);
    const catalog = JSON.parse(read(`${base}actual-original-owner-catalog.json`));
    expect(md5(catalog.gen_definition)).toBe('58dc20e1ba380ccb9b9dee8809731d33');
  });
  it('retains CASE null behavior, canonical identity and historical fallback', () => {
    const s = read(`${base}membership-expression.sql`);
    expect(s).toContain('CASE WHEN v_inv THEN EXISTS');
    expect(s).toContain('ELSE EXISTS');
    expect(s.match(/t.row_id::text=d.tournament_id/g)).toHaveLength(2);
    expect(s.match(/THEN d.tournament_id::uuid END/g)).toHaveLength(2);
    expect(s).toContain("COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text");
    expect(s).not.toContain('observed_at');
  });
  it('installs exact whole owners preserving all metadata and original generation', () => {
    const sql = read(migration);
    expect(sql).toBe(read(`${base}composed-candidate.sql`));
    for (const name of ['report', 'advance', 'guard']) {
      expect(sql).toContain(`EXECUTE $qualified_${name}$${next[name]}$qualified_${name}$`);
      expect(sql).toContain(`original_report_membership_owner_or_authority_changed:${name}`);
    }
    expect(sql).toContain('before_meta IS DISTINCT FROM expected_meta');
    expect(sql).toContain('after_meta IS DISTINCT FROM before_meta');
    expect(sql).toContain('original_report_membership_platform_frozen');
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation'
    );
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });
  it('binds exact qualified inputs and enforces all three native lanes', () => {
    const manifest = JSON.parse(read(`${base}qualified-manifest.json`));
    for (const [path, sha] of Object.entries(manifest.files))
      expect(
        createHash('sha256')
          .update(read(`${base}${path}`))
          .digest('hex')
      ).toBe(sha);
    const workflow = read('.github/workflows/unpaid-lightning-funding-contracts.yml');
    expect(workflow).toContain(`--report-membership-migration ${migration}`);
    expect(workflow).toContain('membership-capacity/native-whole-branch.py');
    expect(workflow).toContain(
      'ORB_REPORT_MEMBERSHIP_NATIVE="$PWD/scripts/qualification/original-retirement-boundary/membership-capacity"'
    );
    const result = JSON.parse(read(`${base}qualified-result.json`));
    expect(result.status).toBe('passed_local_source_qualification_not_installed');
    expect(result.nonempty_touched_branch_cases).toBe(48);
    expect(result.actual65_finite_cases).toBe(245);
  });
});
