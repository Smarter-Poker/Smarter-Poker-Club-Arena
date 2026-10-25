import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  CORRECTIVE_ROLLBACK_FILES,
  correctiveRollbackReportIsComplete,
  isExecutedCorrectiveKernelRollback,
  executeCorrectiveKernelRollback,
} from './kernelRollbackQualification.js';
const server = '/isolated/server';
const titles = [
  [
    'retires captured nonempty reference plans for the actual corrective fold/call family selected=true',
    'retires captured nonempty reference plans for the actual corrective fold/call family selected=false',
    'withdraws while queued before evaluating a correction',
    'reuses the FAST original frame for DEEP and retires authority before second look',
  ],
  [
    'retires a correction withdrawn while FAST_RESULT is pending at the actual IPC boundary',
    'retires a correction withdrawn while DEEP_RESULT is pending at the actual IPC boundary',
  ],
  [
    'reselects the original baseline and updates the pending witness after withdrawal',
    'withdraws a candidate locally if the actual controller witness is coerced',
  ],
  [
    'accepts only the authority-selected real controller action after pending IPC withdrawal=false with chips conserved',
    'accepts only the authority-selected real controller action after pending IPC withdrawal=true with chips conserved',
  ],
  [
    'restores the recorded epoch even for applied=true, without taking authority from recorded flags',
    'restores the recorded epoch even for applied=false, without taking authority from recorded flags',
    'exactly replays the bound accepted DEEP decision with original FAST selected=false',
    'exactly replays the bound accepted DEEP decision with original FAST selected=true',
  ],
];
function report() {
  return {
    success: true,
    numTotalTests: 14,
    numPassedTests: 14,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    testResults: CORRECTIVE_ROLLBACK_FILES.map((file, index) => ({
      name: join(server, file),
      status: 'passed',
      assertionResults: titles[index]!.map((title) => ({
        title,
        status: 'passed',
        failureMessages: [] as string[],
      })),
    })),
  };
}
describe('finite executed rollback report and custody', () => {
  it('recognizes the complete exact transport without granting execution custody', () => {
    const value = report();
    expect(correctiveRollbackReportIsComplete(value, server)).toBe(true);
    expect(isExecutedCorrectiveKernelRollback(value)).toBe(false);
    expect(isExecutedCorrectiveKernelRollback(JSON.parse(JSON.stringify(value)))).toBe(false);
  });
  it.each(['skipped', 'pending', 'todo', 'failed'])(
    'refuses a required %s result despite success counters',
    (status) => {
      const value = report();
      value.testResults[0]!.assertionResults[0]!.status = status;
      expect(correctiveRollbackReportIsComplete(value, server)).toBe(false);
    }
  );
  it('refuses omissions, duplicate identities, wrong source paths and false counters', () => {
    const omitted = report();
    omitted.testResults[0]!.assertionResults.pop();
    const duplicated = report();
    duplicated.testResults[0]!.assertionResults.push(
      duplicated.testResults[0]!.assertionResults[0]!
    );
    const wrongFile = report();
    wrongFile.testResults[0]!.name = '/other/phase14Worker.test.ts';
    const falseCount = report();
    falseCount.numPassedTests++;
    const falseSuite = report();
    falseSuite.testResults[0]!.status = 'failed';
    for (const value of [omitted, duplicated, wrongFile, falseCount, falseSuite])
      expect(correctiveRollbackReportIsComplete(value, server)).toBe(false);
  });
  it('refuses a forged evidence object even if all public fields claim success', () => {
    expect(
      isExecutedCorrectiveKernelRollback(
        Object.freeze({
          version: 'horse-phase14-executed-rollback-v1',
          sourceRelease: 'a'.repeat(40),
          policyDigest: 'b'.repeat(64),
          baselineSelectionsDigest: 'c'.repeat(64),
          rollbackDigest: 'd'.repeat(64),
          mechanismOnly: true,
        })
      )
    ).toBe(false);
  });
  it('refuses malformed bindings before any executable test process can start', () => {
    expect(
      executeCorrectiveKernelRollback(
        {
          sourceRelease: 'not-a-sha',
          policyDigest: 'b'.repeat(64),
          baselineSelectionsDigest: 'c'.repeat(64),
        },
        '/no-scratch'
      )
    ).toEqual({ status: 'unavailable', reason: 'rollback_binding_invalid' });
  });
});
