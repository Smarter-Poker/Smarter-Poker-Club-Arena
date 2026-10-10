import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(__dirname, '..');
const name = fs
  .readdirSync(path.join(root, 'supabase/migrations'))
  .find((n) => n.includes('_lightning_phase_12_load_chaos_stale_groups'))!;
const sql = fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const fixture = fs.readFileSync(
  path.join(root, 'scripts/dev/fixtures/lightning-stale-plan-progress.sql'),
  'utf8'
);
const harness = fs.readFileSync(
  path.join(root, 'scripts/dev/test-lightning-phase12-load-chaos.sh'),
  'utf8'
);
test('only stale legal candidates retain disjoint progress, behind the real barrier and exact owner preimage', () => {
  expect(sql).toContain('a66e718780e9d873a62ee826411d546a');
  expect(sql).toContain("IF (v_r ->> ''reason'') = ''insufficient_legal_candidates'' THEN");
  expect(sql).toContain('CONTINUE;');
  expect(sql).toContain('proacl IS DISTINCT FROM original_acl');
  expect(sql).toContain('proowner IS DISTINCT FROM original_owner');
  expect(sql).toContain('v_form_started >= v_budget');
  expect(sql).not.toMatch(
    /SET\s+.*pass_time_budget_ms|CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public.fn_lightning_form_hand/i
  );
});
test('maintained native gate proves failure-before, real validation-after and exact replay without whitelisting starvation', () => {
  expect(harness).toContain('"${PSQL[@]}" -f "$F/lightning-stale-plan-progress.sql"');
  expect(fixture).toContain("ARRAY['before','after']");
  expect(fixture).toContain('NOT lc.pass_starved(r)');
  expect(fixture).toContain('lc.pass_starved(r) OR n<2');
  expect(fixture).toContain('stale candidate bypassed authoritative validation');
  expect(fixture).toContain('"pass_time_budget_ms":1500');
  expect(fixture).toContain("jsonb_build_object('replayed',true)");
  expect(fixture.trim()).toMatch(/ROLLBACK;$/);
});

test('both required accounting native chains execute the final owner and countercase', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  expect(ci.match(/run: bash scripts\/dev\/test-lightning-phase12-load-chaos.sh/g)).toHaveLength(2);
  const p13 = ci
    .split(
      '- name: Lightning Phase 12 load, stress and chaos rig over the chain through Phase 13'
    )[1]
    .split('- name:')[0];
  expect(p13).toContain('if: matrix.shard == 1');
  expect(p13).toContain(name);
  expect(p13).toContain('LIGHTNING_CHAOS_PROFILE: ci');
  expect(harness).toContain('verify-lightning-stale-progress-owner.mjs');
  expect(sql).toContain('Lightning matcher patched owner drifted');
  expect(sql).toContain('8e06bde427b2b38939194c4ebb16c7de');
  expect(sql).toContain('449fdbe1fa82cf75c17129b098e1c5f9');
});

test('native guard resolves the exact server dependency installed by its accounting shard', () => {
  const driver = fs.readFileSync(
    path.join(root, 'scripts/dev/verify-lightning-stale-progress-owner.mjs'),
    'utf8'
  );
  expect(driver).toContain(
    "createRequire(new URL('../../server/package.json', import.meta.url))('pg')"
  );
  expect(driver).not.toMatch(/import\s+pg\s+from\s+['"]pg['"]/);
});
