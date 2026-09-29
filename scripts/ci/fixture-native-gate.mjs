import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A CANCELLED UPSTREAM IS NOT A VERDICT (2026-09-26).
//
// Run 36154166920 on PR #5242 was cancelled by a duplicate run for the same
// head sha. Its compilation job never started, this gate read
// COMPILE_RESULT=cancelled and printed FIXTURE_GATE_COMPILATION_REQUIRED: a
// code failure, about code nothing had compiled. A cancelled job says nothing
// about the commit; the run that superseded it carries the verdict.
//
// So a cancellation gets its own name and its own exit code (3, the estate's
// "could not tell", CLAUDE.md 10.86 rule 1) instead of being folded into a
// failure. It is NEVER green: the gate still refuses, so a required check can
// not be satisfied by a run that verified nothing. And a real failure always
// wins: if anything the gate certifies actually failed, that failure is what
// is reported, however many sibling jobs were cancelled around it.
export const NO_VERDICT_EXIT_CODE = 3;
export class FixtureGateNoVerdict extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureGateNoVerdict';
    this.code = 'FIXTURE_GATE_NO_VERDICT_CANCELLED';
  }
}
const FAILED = new Set(['failure', 'timed_out']);

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
  const certified = [compileResult, nativeResult];
  if (certified.includes('cancelled') && !certified.some((result) => FAILED.has(result))) {
    throw new FixtureGateNoVerdict(
      `FIXTURE_GATE_NO_VERDICT_CANCELLED: compilation=${compileResult} native=${nativeResult}. ` +
        'This run was cancelled before it could verify the commit, so it is not a verdict ' +
        'either way. The run that superseded it carries the required check.'
    );
  }
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

function runFromEnvironment() {
  return requireFixtureNativeResult({
    eventName: process.env.CI_EVENT_NAME,
    compileResult: process.env.COMPILE_RESULT,
    diffResult: process.env.DIFF_RESULT,
    fixtureChanged: process.env.FIXTURE_CHANGED,
    nativeResult: process.env.NATIVE_RESULT,
    nativeVerified: process.env.NATIVE_VERIFIED,
    sourceSha: process.env.SOURCE_SHA,
    nativeSourceSha: process.env.NATIVE_SOURCE_SHA,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(runFromEnvironment());
  } catch (error) {
    if (error instanceof FixtureGateNoVerdict) {
      console.log(`::notice title=NO VERDICT (CANCELLED)::${error.message}`);
      console.error(error.message);
      process.exit(NO_VERDICT_EXIT_CODE);
    }
    throw error;
  }
}
