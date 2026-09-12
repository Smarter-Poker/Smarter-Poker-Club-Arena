import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requireFixtureNativeResult({
  eventName,
  compileResult,
  diffResult,
  fixtureChanged,
  nativeResult,
}) {
  assert.equal(eventName, 'pull_request', 'FIXTURE_GATE_PULL_REQUEST_REQUIRED');
  assert.equal(compileResult, 'success', 'FIXTURE_GATE_COMPILATION_REQUIRED');
  // Only a positively checked, explicitly unaffected diff permits a skip.
  // Missing/failed classification or malformed output requires real native work.
  const required = diffResult !== 'success' || fixtureChanged !== 'false';
  if (required) {
    assert.equal(nativeResult, 'success', 'FIXTURE_GATE_NATIVE_SUCCESS_REQUIRED');
    return 'Compilation and required native fixture verification passed.';
  }
  assert.ok(
    nativeResult === 'skipped' || nativeResult === 'success',
    'FIXTURE_GATE_UNEXPECTED_NATIVE_OUTCOME'
  );
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
    })
  );
}
