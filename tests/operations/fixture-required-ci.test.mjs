import assert from 'node:assert/strict';
import test from 'node:test';
import { requireFixtureNativeResult } from '../../scripts/ci/fixture-native-gate.mjs';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

test('R46 native callers, fixture inputs and result consumers require accounting execution', () => {
  for (const path of [
    'scripts/ci/test-mtt-unlimited.py',
    'scripts/ci/mtt_unlimited_fixture.py',
    'scripts/ci/mtt_isolation_results.py',
    'scripts/ci/fixtures/mtt-unlimited/schema.sql',
    'scripts/ci/fixtures/mtt-unlimited/source-binding.json',
    'scripts/ci/probes/mtt-unlimited-entry-cap-native.sql',
    'scripts/ci/probes/mtt-unlimited-ticket-redemption-native.sql',
    'scripts/ci/probes/mtt-satellite-creation-native.sql',
    'scripts/ci/probes/existing-ticket-current-redemption-native.sql',
    'scripts/ci/probes/mtt-isolation/fixture.sql',
    'scripts/ci/probes/mtt-isolation/creation-commit.spec',
    'scripts/ci/probes/mtt-isolation/creation-rollback.spec',
    'scripts/ci/probes/mtt-isolation/edit-after-creation.spec',
    'scripts/ci/probes/mtt-isolation/edit-before-creation.spec',
    'scripts/ci/probes/mtt-isolation/restart-commit.spec',
    'scripts/ci/probes/mtt-isolation/restart-rollback.spec',
    'scripts/ci/probes/mtt-isolation/catalog-candidate.json',
    'tests/operations/mtt-isolation-results.test.py',
    'tests/operations/mtt-unlimited-runner.test.py',
    'tests/operations/fixture-required-ci.test.mjs',
  ]) {
    const flags = classifyChangedPaths([path]);
    assert.equal(flags.server, true, `${path} must select the existing accounting job`);
    assert.equal(flags.tests, true, `${path} must retain regression execution`);
    assert.equal(flags.src, false, `${path} does not require a browser build`);
    assert.equal(flags.phase4, false, `${path} does not affect the solver`);
  }
});

test('MTT routing preserves ordinary server gates and excludes unrelated lookalike paths', () => {
  for (const path of ['server/src/GameServer.ts', 'supabase/migrations/change.sql', 'scripts/dev/probe-pko.sh']) {
    assert.equal(classifyChangedPaths([path]).server, true, path);
  }
  for (const path of [
    'docs/mtt-unlimited.md',
    'scripts/ci/test-mtt-unlimited.py.backup',
    'scripts/ci/probes/other-native.sql',
    'scripts/ci/fixtures/mtt-unlimited-other/schema.sql',
    'tests/operations/unrelated.test.py',
  ]) {
    assert.equal(classifyChangedPaths([path]).server, false, path);
  }
});

const verified = {
  eventName: 'pull_request',
  compileResult: 'success',
  diffResult: 'success',
  fixtureChanged: 'true',
  nativeResult: 'success',
  nativeVerified: 'true',
  sourceSha: 'a'.repeat(40),
  nativeSourceSha: 'a'.repeat(40),
};

test('affected ready or draft source requires genuine successful native outcome', () => {
  assert.match(requireFixtureNativeResult(verified), /required native fixture verification passed/);
  for (const nativeResult of ['skipped', 'failure', 'cancelled', 'timed_out', '', undefined]) {
    assert.throws(
      () => requireFixtureNativeResult({ ...verified, nativeResult }),
      /FIXTURE_GATE_NATIVE_SUCCESS_REQUIRED/
    );
  }
});

test('missing or failed classification cannot turn skipped native work green', () => {
  for (const diffResult of ['failure', 'cancelled', 'skipped', '', undefined]) {
    assert.throws(
      () =>
        requireFixtureNativeResult({
          ...verified,
          diffResult,
          fixtureChanged: 'false',
          nativeResult: 'skipped',
        }),
      /FIXTURE_GATE_NATIVE_SUCCESS_REQUIRED/
    );
  }
  for (const fixtureChanged of ['', 'unknown', undefined, false]) {
    assert.throws(
      () =>
        requireFixtureNativeResult({
          ...verified,
          fixtureChanged,
          nativeResult: 'skipped',
        }),
      /FIXTURE_GATE_NATIVE_SUCCESS_REQUIRED/
    );
  }
});

test('successful native work cannot hide skipped or failed compilation', () => {
  for (const compileResult of ['skipped', 'failure', 'cancelled', '', undefined]) {
    assert.throws(
      () => requireFixtureNativeResult({ ...verified, compileResult }),
      /FIXTURE_GATE_COMPILATION_REQUIRED/
    );
  }
});

test('a positively unaffected diff reports its skip without claiming native execution', () => {
  assert.match(
    requireFixtureNativeResult({ ...verified, fixtureChanged: 'false', nativeResult: 'skipped' }),
    /skipped for a verified unaffected diff/
  );
  for (const nativeResult of ['failure', 'cancelled', '', undefined]) {
    assert.throws(
      () => requireFixtureNativeResult({ ...verified, fixtureChanged: 'false', nativeResult }),
      /FIXTURE_GATE_UNEXPECTED_NATIVE_OUTCOME/
    );
  }
});

test('a scheduled or missing event cannot satisfy the pull-request required gate', () => {
  for (const eventName of ['schedule', 'push', '', undefined]) {
    assert.throws(
      () => requireFixtureNativeResult({ ...verified, eventName }),
      /FIXTURE_GATE_PULL_REQUEST_REQUIRED/
    );
  }
});

test('a green wrapper without executed proof or with another source is refused', () => {
  for (const nativeVerified of [undefined, '', 'false', true]) {
    assert.throws(
      () => requireFixtureNativeResult({ ...verified, nativeVerified }),
      /FIXTURE_GATE_EXECUTED_PROOF_REQUIRED/
    );
  }
  for (const sourceSha of [undefined, '', 'main', 'a'.repeat(39)]) {
    assert.throws(
      () => requireFixtureNativeResult({ ...verified, sourceSha }),
      /FIXTURE_GATE_SOURCE_REQUIRED/
    );
  }
  for (const nativeSourceSha of [undefined, '', 'b'.repeat(40)]) {
    assert.throws(
      () => requireFixtureNativeResult({ ...verified, nativeSourceSha }),
      /FIXTURE_GATE_EXACT_SOURCE_REQUIRED/
    );
  }
});
