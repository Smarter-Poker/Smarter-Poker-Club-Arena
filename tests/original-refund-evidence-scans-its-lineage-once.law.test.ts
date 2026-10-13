import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const dir = 'scripts/qualification/original-refund-evidence/';
const migration = read(
  'supabase/migrations/20261013063142_original_refund_evidence_scans_its_application_lineage_once.sql'
);
const before = read(dir + 'before-flow.sql');
const owners = JSON.parse(read(dir + 'current-owner-functions.json'));
describe('original refund evidence preserves its original economic lineage', () => {
  it('changes only RF resolution and preserves every other original branch byte for byte', () => {
    const oldRF = before.match(
      / {2}LEFT JOIN LATERAL \(\n {3}SELECT count\(\*\) refunds,[\s\S]*?\n {2}\) rf ON true/
    )?.[0];
    const newRF = migration.match(
      / {2}LEFT JOIN LATERAL \(\n {3}SELECT r.refunds,[\s\S]*?\n {2}\) rf ON true/
    )?.[0];
    expect(oldRF).toBeTruthy();
    expect(newRF).toBeTruthy();
    const definition = migration.match(
      /CREATE OR REPLACE FUNCTION public\.fn_union_pnl_original_flow_evidence[\s\S]*?\$function\$;/
    )?.[0];
    expect(definition).toBeTruthy();
    const restored = definition!
      .replace(
        / \), rf_original_keys AS MATERIALIZED \([\s\S]*?\n \), matched AS \(/,
        ' ), matched AS ('
      )
      .replace('COALESCE(rf.refunds,0) refunds,rf.club', 'rf.refunds,rf.club')
      .replace(newRF!, oldRF!);
    expect(restored.trim()).toBe(before.trim());
  });
  it('changes exactly one actual current source40 tuple and retains security and fail closed installation', () => {
    const oldMatcher = owners[1].definition.trim();
    const newMatcher = migration.match(
      /CREATE OR REPLACE FUNCTION smarter_private\.original_inventory_proof_sources_match\(\)[\s\S]*?AS \$function\$[\s\S]*?\$function\$/
    )?.[0];
    expect(newMatcher).toBe(
      oldMatcher.replace('308cbce5cddd70d9158c0ffa0220cb43', '5477b968656e1179aa25d7ec9bc527ca')
    );
    for (const phrase of [
      "statement_timeout='20s'",
      "lock_timeout='2s'",
      'IS DISTINCT FROM false',
      'n IS DISTINCT FROM 2',
      'original_rf_operator_refused',
      'original_rf_preimage_refused',
      'original_rf_postimage_refused',
    ])
      expect(migration).toContain(phrase);
    expect(migration).not.toMatch(
      /CREATE\s+(?:UNIQUE\s+)?INDEX|UPDATE\s+[^;]*certificate|DELETE\s+FROM|TRUNCATE|cron\.schedule/i
    );
  });
  it('enforces actual classification and source40 qualification in the maintained accounting job', () => {
    const driver = read(dir + 'classify-native.py');
    expect(driver).toContain("assert results['before']==results['after']");
    expect(driver).toContain("n.get('Actual Loops',0)>=1024");
    expect(driver).toContain("n.get('Actual Loops',0)<=1");
    expect(driver).toContain('27557');
    expect(read(dir + 'installer-native.py')).toContain('assert len(sources)==40');
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/qualification/original-refund-evidence/run-native.py --output'
    );
    expect(read(dir + 'run-native.py')).toContain("run('installer'");
  });
});
