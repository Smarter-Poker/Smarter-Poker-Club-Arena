import { describe, expect, it } from 'vitest';
import {
  CORRECTIVE_ISSUER_CONTROL_FILES,
  correctiveIssuerControlFingerprint,
} from './kernelIssuerControl.js';
describe('current protected privileged control bytes', () => {
  it('includes its own verifier, public trust, operator, workflow and every direct evidence owner', () => {
    expect(CORRECTIVE_ISSUER_CONTROL_FILES).toContain(
      'server/src/services/horseCorrectiveReview/kernelIssuerControl.ts'
    );
    expect(CORRECTIVE_ISSUER_CONTROL_FILES).toContain(
      'server/src/services/horseCorrectiveReview/kernelIssuerTrust.ts'
    );
    expect(CORRECTIVE_ISSUER_CONTROL_FILES).toContain(
      '.github/workflows/horse-phase14-qualification.yml'
    );
    expect(CORRECTIVE_ISSUER_CONTROL_FILES).toContain(
      'server/src/services/horseCorrectiveReview/riverSourcePopulation.ts'
    );
  });
  it.each([
    'server/src/services/horseCorrectiveReview/kernelRollbackQualification.ts',
    'server/src/services/horseCorrectiveReview/private-journal-command.sh',
    'server/src/services/horseCorrectiveReview/authority.ts',
    'server/src/services/horseCorrectiveReview/domain.ts',
    'server/src/services/horseCorrectiveReview/review.ts',
    'server/src/services/horseCorrectiveReview/riverKernel.ts',
    'server/src/benchmark/JointBoardReference.ts',
    'server/src/benchmark/OmahaReference.ts',
    'server/src/engine/horseDecision/replay/independentQualification.ts',
    'server/src/services/horseDecisionJournal/effects.ts',
    'server/src/engine/horseDecision/phase14Worker.test.ts',
    'server/src/engine/horseDecision/phase14Worker.test-support.ts',
    'server/vitest.config.ts',
    'server/package-lock.json',
    'server/src/testing/theSchedulerStopsBetweenTests.ts',
  ])('refuses changed or missing CURRENT privileged dependency %s', (owner) => {
    expect(CORRECTIVE_ISSUER_CONTROL_FILES).toContain(owner);
    const local = (path: string) => Buffer.from('test-code:' + path);
    expect(
      correctiveIssuerControlFingerprint(local, (path) =>
        Buffer.from(path === owner ? 'old-weaker-verifier' : 'test-code:' + path)
      )
    ).toBeNull();
    expect(
      correctiveIssuerControlFingerprint(local, (path) => {
        if (path === owner) throw Error('missing protected dependency');
        return local(path);
      })
    ).toBeNull();
  });
  it('refuses changed or absent CURRENT control and permits identical bytes despite a docs-only SHA change', () => {
    const local = (path: string) => Buffer.from('test-code:' + path);
    expect(correctiveIssuerControlFingerprint(local, local)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      correctiveIssuerControlFingerprint(local, (path) =>
        Buffer.from(path.endsWith('kernelIssuerTrust.ts') ? 'rotated-pin' : 'test-code:' + path)
      )
    ).toBeNull();
    expect(
      correctiveIssuerControlFingerprint(local, () => {
        throw Error('unknown immutable object');
      })
    ).toBeNull();
  });
});
