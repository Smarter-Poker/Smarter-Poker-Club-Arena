import assert from 'node:assert/strict';
import test from 'node:test';
import { requireFixtureNativeResult } from '../../scripts/ci/fixture-native-gate.mjs';

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
