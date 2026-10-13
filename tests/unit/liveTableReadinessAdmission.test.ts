import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readinessReadCanStart,
  READINESS_HEALTH_READ_MS,
} from '../e2e/support/readinessReadAdmission';
import { OperationalPollFailure } from '../e2e/support/tournamentHudWitness';

const now = 1_791_918_724_814;

describe('live-table readiness starts only admitted health reads', () => {
  it('rejects the original 52ms request rather than blaming transport', () => {
    const deadline = now + 52;
    expect(Math.max(1, Math.min(15_000, Math.floor(deadline - now)))).toBe(52);
    expect(readinessReadCanStart(deadline, now)).toBe(false);
  });

  it('preserves the existing full request budget and the fixed deadline', () => {
    expect(READINESS_HEALTH_READ_MS).toBe(15_000);
    expect(readinessReadCanStart(now + 15_000, now)).toBe(true);
    expect(readinessReadCanStart(now + 14_999, now)).toBe(false);
    expect(readinessReadCanStart(now + 90_000, now)).toBe(true);
    expect(readinessReadCanStart(now, now)).toBe(false);
    expect(readinessReadCanStart(now - 1, now)).toBe(false);
    expect(readinessReadCanStart(Infinity, now)).toBe(false);
    expect(readinessReadCanStart(NaN, now)).toBe(false);
  });

  it('cannot clear a genuine failed read when a later callback is not admitted', async () => {
    const failure = new OperationalPollFailure();
    const transportError = new Error('genuine complete-budget transport refusal');
    await expect(
      failure.attempt(async () => {
        throw transportError;
      })
    ).rejects.toBe(transportError);
    let reads = 0;
    const lateCallback = async () => {
      if (!readinessReadCanStart(now + 52, now)) return 0;
      return failure.attempt(async () => {
        reads++;
        return 0;
      });
    };
    expect(await lateCallback()).toBe(0);
    expect(reads).toBe(0);
    expect(() => failure.rethrowIfPresent()).toThrow(transportError);
  });

  it('wires admission before the operational wrapper in the real unchanged-budget poll', () => {
    const spec = readFileSync(
      join(__dirname, '../e2e/production-live-table-realtime.spec.ts'),
      'utf8'
    );
    const start = spec.indexOf('const readinessPollBudgetMs = pollBudgetMs();');
    const readiness = spec.slice(start, spec.indexOf('let after = before;', start));
    expect(readiness).toContain('if (!readinessReadCanStart(readinessReadDeadline)) return 0;');
    expect(readiness.indexOf('if (!readinessReadCanStart')).toBeLessThan(
      readiness.indexOf('operationalPollFailure.attempt')
    );
    expect(readiness).toContain('timeout: readinessPollBudgetMs');
    expect(readiness).toContain('operationalPollFailure.rethrowIfPresent();');
    expect(readiness).toContain("classification.verdict === 'stalled'");
    expect(readiness).toContain('throw new AbsentCertifiableSubject(');
  });
});
