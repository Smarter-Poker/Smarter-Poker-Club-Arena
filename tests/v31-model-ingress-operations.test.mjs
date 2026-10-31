import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = '20261030023627_v31_model_operations_enter_the_scoped_replay_gate.sql';
const sql = read(`supabase/migrations/${migration}`);
const probe = 'scripts/ci/probes/horse-phase4-certified-solver/';

test('model ingress extends both authoritative owners with explicit principal scopes', () => {
  assert.match(sql, /principal='COMPACTOR' AND operation IN \('prepare_model','freeze_model'\)/);
  assert.match(sql, /principal='M2' AND operation='model_freeze_authority'/);
  assert.match(sql, /p_operation IN \('prepare_model','freeze_model'\) AND p_principal<>'COMPACTOR'/);
  assert.match(sql, /p_operation='model_freeze_authority' AND p_principal<>'M2'/);
  assert.match(sql, /ADD CONSTRAINT solver_ingress_nonces_operation_check CHECK \(\([\s\S]*?\) IS TRUE\)/);
  assert.doesNotMatch(sql, /NOT VALID|DISABLE TRIGGER|GRANT|REVOKE|SET ROLE|UPDATE public\./i);
});

test('migration preserves replay, freshness, digest, ACL and exact preimage safeguards', () => {
  for (const value of ['fd5ebf3b42393a9405dc70ca8919f0a3', '2cabf6a2bb0690ed9b109ab3dc9dd078',
    'd2e67eb56feb819478c725888a2b906f', '8fe624a3f070e1b8b8515d14f421a4a9',
    "SET LOCAL lock_timeout = '1s'", "SET LOCAL statement_timeout = '5s'",
    'SECURITY DEFINER', 'SET search_path = public',
    'abs(extract(epoch FROM (clock_timestamp()-p_signed_at)))>300',
    "!~ '^[0-9a-f]{64}$'", "p_body_sha256=repeat('0',64)",
    'ON CONFLICT (principal,nonce) DO NOTHING', 'solver ingress nonce was replayed']) {
    assert.ok(sql.includes(value), value);
  }
  assert.equal((sql.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((sql.match(/^COMMIT;/gm) ?? []).length, 1);
});

test('existing required V31 gate executes native before/after transition and security boundaries', () => {
  const harness = read(`${probe}run-pg17.sh`);
  const before = harness.indexOf('"$HERE/model-ingress-before.sql"');
  const install = harness.indexOf(`"$ROOT/supabase/migrations/${migration}"`);
  const after = harness.indexOf('"$HERE/model-ingress-after.sql"');
  assert.ok(before > 0 && before < install && install < after);
  assert.match(read('.github/workflows/ci.yml'), /node --test scripts\/ci\/test-v4-policy-metadata\.mjs\s+bash scripts\/ci\/probes\/horse-phase4-certified-solver\/run-pg17\.sh/);
  assert.match(read('scripts/ci/test-v4-policy-metadata.mjs'), /import '\.\.\/\.\.\/tests\/v31-model-ingress-operations\.test\.mjs'/);
  const old = read(`${probe}model-ingress-before.sql`);
  const updated = read(`${probe}model-ingress-after.sql`);
  for (const value of ['original ingress unexpectedly admitted', 'original nonce CHECK unexpectedly admitted',
    '31055', 'function_acl', 'fingerprint']) assert.ok(old.includes(value), value);
  for (const value of ['table CHECK admitted wrong new-operation actor', 'solver ingress nonce was replayed',
    "interval '301 seconds'", "repeat('0',64)", "repeat('B',64)", 'prepare_model_extra',
    'legacy actor/operation', 'retained legacy nonce rows', 'function security identity changed',
    "has_function_privilege('anon'", "has_function_privilege('authenticated'", 'convalidated']) {
    assert.ok(updated.includes(value), value);
  }
});

test('compactor authority aligns exactly both ingress owners and stays in the native required gate', () => {
  const candidate = read('supabase/migrations/20261031135616_v31_compactor_may_read_frozen_model_authority.sql');
  for (const digest of ['d2e67eb56feb819478c725888a2b906f', '8fe624a3f070e1b8b8515d14f421a4a9',
    '051c172d4ae8cf8856bcbd320a1b3e28', 'd9930cbff758f7d4f5fef9a614c2eb47']) {
    assert.ok(candidate.includes(digest), digest);
  }
  assert.ok(candidate.includes("principal IN ('M2','COMPACTOR') AND operation='model_freeze_authority'"));
  assert.ok(candidate.includes("(p_operation=''model_freeze_authority'' AND p_principal<>''M2'')"));
  assert.ok(candidate.includes("(p_operation=''model_freeze_authority'' AND p_principal NOT IN (''M2'',''COMPACTOR''))"));
  assert.equal((candidate.match(/EXECUTE replace\(/g) ?? []).length, 1);
  assert.equal((candidate.match(/ADD CONSTRAINT/g) ?? []).length, 1);
  assert.ok(candidate.includes("principal='COMPACTOR' AND operation IN ('prepare_model','freeze_model')"));
  assert.ok(candidate.includes("v_before IS DISTINCT FROM (SELECT to_jsonb(p)-'prosrc'"));
  assert.ok(candidate.includes('v_table_before IS DISTINCT FROM (SELECT to_jsonb(c)'));
  assert.doesNotMatch(candidate, /NOT VALID|DISABLE TRIGGER|GRANT |REVOKE |SET ROLE|UPDATE public\.|DELETE FROM|statement_timeout = '(?!5s)|lock_timeout = '(?!1s)/i);
  assert.equal((candidate.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((candidate.match(/^COMMIT;/gm) ?? []).length, 1);
  const harness = read(`${probe}run-pg17.sh`);
  assert.ok(harness.includes('PG17_BIN="$PG_BIN" python3 -B "$HERE/test-compactor-freeze-authority-ingress.py"'));
  const native = read(`${probe}test-compactor-freeze-authority-ingress.py`);
  for (const marker of ['20261031135616_v31_compactor_may_read_frozen_model_authority.sql',
    'matrix(False)', 'matrix(True)', 'solver ingress nonce was replayed',
    "interval '301 seconds'", "repeat('B',64)", "role='fixture_owner'", 'table owner/ACL/RLS changed']) {
    assert.ok(native.includes(marker), marker);
  }
});
