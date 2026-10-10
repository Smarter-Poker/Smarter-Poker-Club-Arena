import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const migration = fs.readFileSync(
  new URL(
    '../../../supabase/migrations/20261010131117_close_cash_targets_are_executable.sql',
    import.meta.url
  ),
  'utf8'
);
const runner = fs.readFileSync(
  new URL('../../../scripts/qualify-stable-admin-close-selector.mjs', import.meta.url),
  'utf8'
);
const behavior = fs.readFileSync(
  new URL(
    '../../../scripts/qualification/stable-admin-close-selector/behavior.sql',
    import.meta.url
  ),
  'utf8'
);
const rollback = fs.readFileSync(
  new URL(
    '../../../scripts/qualification/stable-admin-close-selector/rollback.sql',
    import.meta.url
  ),
  'utf8'
);
test('forward replaces only the pinned original floor command with guarded complete target capture', () => {
  assert.match(migration, /f6d78897576ce5a925ca454437cb9e91/);
  assert.match(migration, /pg_get_userbyid\(proowner\)='postgres'/);
  assert.match(migration, /ORDER BY id FOR UPDATE/);
  assert.match(migration, /is_deleted IS DISTINCT FROM false OR game_type IS DISTINCT FROM 'cash'/);
  assert.match(migration, /WHERE id=ANY\(v_close_targets\)/);
  assert.match(migration, /cash_floor_close_target_not_executable/);
  assert.doesNotMatch(
    migration,
    /UPDATE public\.(table_seats|poker_diamond_custody|wallets)|DELETE FROM public\.(table_seats|poker_diamond_custody)/i
  );
});
test('embedded guarded inverse matches actual native rollback source', () => {
  assert.ok(
    migration.includes(
      rollback
        .split('\n')
        .filter(Boolean)
        .map((line) => '-- ' + line)
        .join('\n')
    )
  );
  assert.match(rollback, /close_cash_rollback_source_drift/);
  assert.match(rollback, /pg_get_userbyid\(proowner\)='postgres'/);
});
test('native proof executes original and corrected behavior, row race, security drift and inverse', () => {
  assert.match(runner, /server_version_num/);
  assert.match(runner, /fixtureSql\(\)/);
  assert.match(runner, /EXPECT_REFUSAL.*false/);
  assert.match(runner, /EXPECT_REFUSAL.*true/);
  assert.match(runner, /TARGET_LOCKED/);
  assert.match(runner, /ownerRefused/);
  assert.match(runner, /query\(rollback\)/);
  for (const caseName of ['deleted', 'noncash', 'unknown_type', 'unknown_deleted'])
    assert.ok(behavior.includes(caseName));
  assert.match(behavior, /changed targets never obstruct original operation recovery/);
  assert.match(behavior, /no seat\/custody\/balance mutation/);
});
