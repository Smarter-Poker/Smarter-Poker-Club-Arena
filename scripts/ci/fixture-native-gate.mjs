import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requireFixtureNativeResult({
  eventName,
  compileResult,
  diffResult,
  fixtureChanged,
  nativeResult,
  nativeVerified,
  sourceSha,
  nativeSourceSha,
}) {
  assert.equal(eventName, 'pull_request', 'FIXTURE_GATE_PULL_REQUEST_REQUIRED');
  assert.equal(compileResult, 'success', 'FIXTURE_GATE_COMPILATION_REQUIRED');
  // Only a positively checked, explicitly unaffected diff permits a skip.
  // Missing/failed classification or malformed output requires real native work.
  const required = diffResult !== 'success' || fixtureChanged !== 'false';
  if (required) {
    assert.equal(nativeResult, 'success', 'FIXTURE_GATE_NATIVE_SUCCESS_REQUIRED');
  }
  assert.ok(
    nativeResult === 'skipped' || nativeResult === 'success',
    'FIXTURE_GATE_UNEXPECTED_NATIVE_OUTCOME'
  );
  if (nativeResult === 'success') {
    assert.equal(nativeVerified, 'true', 'FIXTURE_GATE_EXECUTED_PROOF_REQUIRED');
    assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/, 'FIXTURE_GATE_SOURCE_REQUIRED');
    assert.equal(nativeSourceSha, sourceSha, 'FIXTURE_GATE_EXACT_SOURCE_REQUIRED');
  }
  if (required) return 'Compilation and required native fixture verification passed.';
  return nativeResult === 'success'
    ? 'Compilation and native fixture verification passed.'
    : 'Compilation passed. Native fixture skipped for a verified unaffected diff.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(
    requireFixtureNativeResult({
      eventName: process.env.CI_EVENT_NAME,
      compileResult: process.env.COMPILE_RESULT,
      diffResult: process.env.DIFF_RESULT,
      fixtureChanged: process.env.FIXTURE_CHANGED,
      nativeResult: process.env.NATIVE_RESULT,
      nativeVerified: process.env.NATIVE_VERIFIED,
      sourceSha: process.env.SOURCE_SHA,
      nativeSourceSha: process.env.NATIVE_SOURCE_SHA,
    })
  );
}
