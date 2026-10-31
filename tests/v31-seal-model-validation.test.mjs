import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const prefix = 'scripts/ci/probes/horse-phase4-certified-solver/';
const file = '20261031215525_v31_model_validation_serializes_the_same_forest_once.sql';
test('the existing required V31 harness executes both actual seal validation regressions', () => {
  const harness = read(prefix + 'run-pg17.sh');
  for (const name of ['test-public215-seal-validation.py', 'test-public215-seal-locks.py']) {
    assert.ok(harness.includes(`PG17_BIN="$PG_BIN" python3 -B "$HERE/${name}"`));
    assert.ok(read(prefix + name).includes(file));
  }
  assert.match(read('.github/workflows/ci.yml'), /node --test scripts\/ci\/test-v4-policy-metadata\.mjs\s+bash scripts\/ci\/probes\/horse-phase4-certified-solver\/run-pg17\.sh/);
});
test('the migration changes only the closed non-numerical validation owners', () => {
  const sql = read('supabase/migrations/' + file);
  const owners = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(x => x[1]).sort();
  assert.deepEqual(owners, ['fn_gto_v31_cell_payload_checksum', 'fn_gto_v31_public215_canonical', 'fn_gto_v31_public215_model_canonical_fast', 'fn_gto_v31_public215_model_valid', 'fn_gto_v31_seal_build']);
  assert.match(sql, /FOR SHARE/);
  assert.match(sql, /convalidated AND NOT condeferrable/);
  assert.match(sql, /statement_timeout TO '240s'/);
  assert.match(sql, /lock_timeout TO '1s'/);
  assert.equal((sql.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((sql.match(/^COMMIT;/gm) ?? []).length, 1);
  assert.doesNotMatch(sql, /ALTER ROLE|DISABLE TRIGGER|SET ROLE|CREATE INDEX/);
});
