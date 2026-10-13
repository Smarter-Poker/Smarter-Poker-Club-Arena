/**
 * LAW: A REQUESTED RETRY IS NOT A FAILURE (2026-10-12).
 *
 * The post-commit obligation loop reported its first failure as
 * ServerTableEngine.post_commit_obligations_pending. 106 of 133 such reports
 * in five hours were F06_RETRY_CANONICAL_LANE, the database asking for the same
 * transaction again before writing anything, and every one applied on a later
 * attempt. The first attempt of that request is quiet; any other first failure,
 * every tenth attempt of any cause and the give-up alert are unchanged.
 *
 * Registry: docs/laws.d/server-src-engine-aRequestedRetryIsNotAFailure.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRequestedLaneRetry, shouldReportPostCommitAttempt } from './postCommitRetryReport.js';

const lane = new Error('post-commit obligations RPC failed: F06_RETRY_CANONICAL_LANE (55P03)');

describe('a requested retry is not a failure', () => {
  it('recognises the canonical lane retry request', () => {
    expect(isRequestedLaneRetry(lane)).toBe(true);
    expect(isRequestedLaneRetry({ message: 'F06_RETRY_CANONICAL_LANE', code: '40001' })).toBe(true);
    expect(isRequestedLaneRetry(new Error('supabase_timeout'))).toBe(false);
    expect(isRequestedLaneRetry(new Error('f06_finish_unproven'))).toBe(false);
    expect(isRequestedLaneRetry(null)).toBe(false);
  });

  it('is quiet only on the first attempt of a requested retry', () => {
    expect(shouldReportPostCommitAttempt(1, lane)).toBe(false);
    expect(shouldReportPostCommitAttempt(2, lane)).toBe(false);
    expect(shouldReportPostCommitAttempt(10, lane)).toBe(true);
    expect(shouldReportPostCommitAttempt(20, lane)).toBe(true);
  });

  it('still reports every other first failure and every tenth attempt', () => {
    for (const other of [
      new Error('supabase_timeout'),
      new Error('f06_finish_unproven'),
      new Error('post-commit obligations RPC failed: deadlock detected (40P01)'),
    ]) {
      expect(shouldReportPostCommitAttempt(1, other)).toBe(true);
      expect(shouldReportPostCommitAttempt(2, other)).toBe(false);
      expect(shouldReportPostCommitAttempt(10, other)).toBe(true);
    }
  });

  it('the settlement loop asks this rule and keeps the give-up alert', () => {
    const src = readFileSync(join(__dirname, 'ServerTableEngineSettlement.ts'), 'utf8');
    expect(src).toMatch(
      /if \(shouldReportPostCommitAttempt\(attempt, err\)\) \{\s+reportError\(err, 'ServerTableEngine\.post_commit_obligations_pending'/
    );
    expect(src).toMatch(
      /raiseFinancialAlert\(\s+'critical',\s+'ServerTableEngine\.post_commit_obligations_pending'/
    );
  });
});
