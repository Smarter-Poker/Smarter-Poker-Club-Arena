import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const prefix = 'scripts/ci/probes/horse-phase4-certified-solver/';
const file = '20261031215525_v31_model_validation_serializes_the_same_forest_once.sql';
test('the existing required V31 harness executes all actual seal validation regressions', () => {
  const harness = read(prefix + 'run-pg17.sh');
  for (const name of ['test-public215-seal-validation.py', 'test-public215-seal-locks.py', 'test-public215-source-vectors.py']) {
    assert.ok(harness.includes(`PG17_BIN="$PG_BIN" python3 -B "$HERE/${name}"`));
    assert.ok(read(prefix + name).includes(file));
  }
  assert.match(read('.github/workflows/ci.yml'), /node --test scripts\/ci\/test-v4-policy-metadata\.mjs\s+bash scripts\/ci\/probes\/horse-phase4-certified-solver\/run-pg17\.sh/);
});
test('the migration changes only the closed non-numerical validation owners', () => {
  const sql = read('supabase/migrations/' + file);
  const owners = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(x => x[1]).sort();
  assert.deepEqual(owners, ['fn_gto_v31_cell_payload_checksum', 'fn_gto_v31_public215_canonical', 'fn_gto_v31_public215_model_canonical_fast', 'fn_gto_v31_public215_model_valid', 'fn_gto_v31_seal_build', 'fn_gto_v31_source_node_v3_fields_valid', 'fn_gto_v31_source_node_v3_valid', 'fn_gto_v31_source_node_v4_valid']);
  assert.match(sql, /FOR SHARE/);
  assert.match(sql, /convalidated AND NOT condeferrable/);
  assert.match(sql, /statement_timeout TO '240s'/);
  assert.match(sql, /lock_timeout TO '1s'/);
  assert.equal((sql.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((sql.match(/^COMMIT;/gm) ?? []).length, 1);
  assert.doesNotMatch(sql, /ALTER ROLE|DISABLE TRIGGER|SET ROLE|CREATE INDEX/);
});

test('source field helper retains service-only invoker access and exact vector preimages', () => {
  const sql=read('supabase/migrations/'+file);
  const start=sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_node_v3_fields_valid(');
  const core=sql.slice(start,sql.indexOf('$fn$;',start)+6);
  assert.ok(start>=0);
  assert.doesNotMatch(core,/SECURITY DEFINER/);
  for (const hash of ['fd185af67a480d8262109575a25ac51e', '4af1170638a0145b286b4b687d998fc3', '13b7724a355d40bcc1ca9eb5a8888127', '4757f9005ca956a453ce7be1f5e70d25', '56dad8b4161a1a112d9b72c814efdbfd']) assert.ok(sql.includes(hash));
});
