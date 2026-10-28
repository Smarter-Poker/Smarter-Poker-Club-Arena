import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = 'scripts/qualification/original-retirement-boundary/report-reader-composition/';
const read = (path: string) => readFileSync(path, 'utf8');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const migration =
  'supabase/migrations/20261028002753_original_weekly_report_uses_its_qualified_hand_readers.sql';
const old = Object.fromEntries(
  ['report', 'advance', 'guard'].map((name) => [name, read(`${base}${name}-original.sql`)])
);
const next = Object.fromEntries(
  ['report', 'advance', 'guard'].map((name) => [name, read(`${base}${name}-candidate.sql`)])
);

// Native qualification invokes the complete report and its real original84
// advance/reduce/witness/read owners. This contract preserves its exact scope.
describe('the original weekly report consumes its qualified hand readers', () => {
  it('changes exactly the missed report caller and its two direct hash callers', () => {
    expect(md5(old.report)).toBe('c4a17522149bfd879342ccc68dec98f9');
    expect(md5(old.advance)).toBe('2627c8820e0147d5e91a2014415ec558');
    expect(md5(old.guard)).toBe('8734797c6093c7e5a2a72de9b387a6de');
    expect(next.report).toBe(
      old.report
        .replace('491323192dc49931df7c36e4699eac9a', 'a3b1c75ad2b122dc0b0fede8a66813c8')
        .replace('1ecd757e644477bb02400a17b53edd32', 'd427fd27d163ba72a7dc3cd50866163d')
    );
    expect(next.advance).toBe(old.advance.replace(md5(old.report), md5(next.report)));
    expect(next.guard).toBe(
      old.guard
        .replace(md5(old.report), md5(next.report))
        .replace(md5(old.advance), md5(next.advance))
    );
  });

  it('preserves the other63 sources and the complete generation owner', () => {
    const pins = (value: string) =>
      new Map([...value.matchAll(/\('([^']+)','([a-f0-9]{32})'\)/g)].map((m) => [m[1], m[2]]));
    const before = pins(old.guard);
    const after = pins(next.guard);
    expect(before.size).toBe(65);
    expect(after.size).toBe(65);
    expect(
      [...before.keys()]
        .filter((signature) => before.get(signature) !== after.get(signature))
        .sort()
    ).toEqual([
      'public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)',
      'public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)',
    ]);
    const captured = JSON.parse(read(`${base}actual-original-owner-catalog.json`));
    expect(md5(captured.gen_definition)).toBe('58dc20e1ba380ccb9b9dee8809731d33');
    expect(read(migration)).not.toContain(
      'CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation'
    );
  });

  it('preserves authority and atomically installs the exact qualified bodies', () => {
    const sql = read(migration);
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      '8a12bc5d85793cc13aafc66d13e85a6204b05f18efab0ee2826131b80e5d93d5'
    );
    for (const name of ['report', 'advance', 'guard']) {
      expect(sql).toContain(`EXECUTE $qualified_${name}$${next[name]}$qualified_${name}$`);
      expect(sql).toContain(`original_report_composition_owner_or_authority_changed:${name}`);
      expect(sql).toContain(`original_report_composition_postimage_changed:${name}`);
    }
    expect(sql).toContain('after_meta IS DISTINCT FROM before_meta');
    expect(sql).toContain('before_meta IS DISTINCT FROM expected_meta');
    expect(sql).toContain('original_report_composition_platform_frozen');
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('binds the retained source qualification inputs without claiming installation', () => {
    const manifest = JSON.parse(read(`${base}qualified-manifest.json`));
    for (const [path, sha] of Object.entries(manifest.files)) {
      expect(
        createHash('sha256')
          .update(read(`${base}${path}`))
          .digest('hex')
      ).toBe(sha);
    }
    const result = JSON.parse(read(`${base}qualified-result.json`));
    expect(result.status).toBe('passed_local_source_qualification_not_installed');
    expect(result.targeted_native.cases).toBe(62);
    expect(result.actual65_authority_native.finite_cases).toBe(245);
    expect(read(`${base}composed-candidate.sql`)).toBe(read(migration));
  });

  it('enforces both the full report and actual65 installer native lanes', () => {
    const workflow = read('.github/workflows/unpaid-lightning-funding-contracts.yml');
    expect(workflow).toContain(`--report-reader-composition-migration ${migration}`);
    expect(workflow).toContain(
      'ORB_REPORT_COMPOSITION_NATIVE="$PWD/scripts/qualification/original-retirement-boundary/report-reader-composition/native-report.py" python3'
    );
    const native = read(`${base}native-report.py`);
    expect(native).toContain("q(settings+report_call,'weekly_hand_parts_owner_changed')");
    expect(native).toContain('q(candidate_report)');
    expect(native).toContain(
      'actual_full_report_stale_hand_part_rebuilt_by_original_advance_returns_warming'
    );
    expect(read(`${base}native-authority-after.sql`)).toContain(
      'report_composition_native_other63_sources_changed'
    );
  });
});
