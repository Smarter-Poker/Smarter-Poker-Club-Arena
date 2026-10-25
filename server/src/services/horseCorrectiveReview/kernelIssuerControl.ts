/** Compare privileged control bytes with CURRENT protected main without
 * executing another revision or changing the original-policy evaluation tree. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { correctiveReviewerChildEnvironment } from './reviewerEnvironment.js';
export const CORRECTIVE_ISSUER_CONTROL_FILES = Object.freeze(
  [
    '.github/workflows/horse-phase14-qualification.yml',
    'scripts/ci/check-phase14-generation-ledger.mjs',
    'server/src/scripts/horseCorrectiveKernelIssue.ts',
    'server/src/scripts/horsePrivateJournalExport.ts',
    ...[
      'kernelTournamentDefinition.ts',
      'kernelTournamentApproval.ts',
      'kernelTournamentCatalog.ts',
      'kernelObjective.ts',
      'kernelModel.ts',
      'kernelTournamentEligibility.ts',
      'tournamentRiverReference.ts',
      'closedHeadsUpTournamentRiverReference.ts',
      'tournamentRiverKernel.ts',
      'tournamentAcceptedUtility.ts',
      'tournamentAcceptedFunding.ts',
      'tournamentIndependentReview.ts',
      'tournamentModelHoldout.ts',
      'pairedHoldoutMeasurement.ts',
      'kernelIssuer.ts',
      'kernelIssuerTrust.ts',
      'kernelSignerIdentity.ts',
      'kernelIssuerControl.ts',
      'kernelGenerationProvider.ts',
      'kernelGenerationLedger.ts',
      'kernelGenerationLedgerRules.mjs',
      'kernelGenerationLedgerRules.d.mts',
      'riverSourcePopulation.ts',
      'journalTransport.ts',
      'private-journal-command.sh',
      'riverAcceptedWindow.ts',
      'riverAcceptedOracle.ts',
      'kernelQualificationReview.ts',
      'kernelRollbackQualification.ts',
      'authority.ts',
      'domain.ts',
      'eligibility.ts',
      'review.ts',
      'roster-adapter.ts',
      'contract.ts',
      'riverKernel.ts',
      'kernelReceipt.ts',
      'fixture.test-support.ts',
      'kernelApproval.test-support.ts',
      'kernelAdmission.test-support.ts',
      'riverReference.test-support.ts',
      'kernelPredeclaration.ts',
      'reviewerEnvironment.ts',
      'kernelReviewInput.ts',
      'kernelOriginalInput.ts',
      'riverIndependentReview.ts',
      'kernelIndependentReview.ts',
      'riverModelHoldout.ts',
      'riverHoldout.ts',
      'kernelApproval.ts',
      'kernelCatalog.ts',
      'kernelAdmission.ts',
      'kernelPolicyDigest.ts',
      'kernelEligibility.ts',
      'kernelDefinition.ts',
      'riverDecisionModel.ts',
      'riverReference.ts',
      'privateFiles.ts',
    ].map((file) => 'server/src/services/horseCorrectiveReview/' + file),
    ...[
      'exactReplay.ts',
      'runtimeReplay.ts',
      'qualifiedAuthority.ts',
      'reconstruct.ts',
      'independentQualification.ts',
      'references.ts',
      'HorseDecisionReplay.ts',
      'verdict.ts',
    ].map((file) => 'server/src/engine/horseDecision/replay/' + file),
    'server/src/services/horseDailyCorrectiveReview/source.ts',
    'server/src/services/horseDailyCorrectiveReview/mapping.ts',
    'server/src/services/horseAcceptedRoster/exporter.ts',
    'server/src/services/horseAcceptedRoster/acceptance.ts',
    'server/src/services/horseDecisionJournal/review.ts',
    'server/src/services/horseDecisionJournal/record.ts',
    'server/src/services/horseDecisionJournal/effects.ts',
    ...['eligibility.ts', 'authority.ts', 'schema.ts'].map(
      (file) => 'server/src/services/horseAcceptedRoster/' + file
    ),
    ...[
      'JointBoardReference.ts',
      'OmahaReference.ts',
      'RemainingVariantReference.ts',
      'RemainingVariantPolicyEvidence.ts',
      'OmahaVariantPolicyEvidence.ts',
    ].map((file) => 'server/src/benchmark/' + file),
    'server/src/engine/HorseTournamentPayoutTerms.ts',
    'server/src/engine/HorseTournamentContextProvenance.ts',
    'server/src/engine/omaha/OmahaCardFacts.ts',
    ...[
      'phase14Worker.test.ts',
      'phase14Tournament.test.ts',
      'phase14Client.test.ts',
      'phase14Controller.test.ts',
      'phase14Replay.test.ts',
      'phase14Worker.test-support.ts',
    ].map((file) => 'server/src/engine/horseDecision/' + file),
    'server/src/engine/HorsePhase14Acceptance.test.ts',
    'server/src/engine/multiway/JointRangeFixture.test-support.ts',
    'server/vitest.config.ts',
    'server/package.json',
    'server/package-lock.json',
    ...[
      'waitBudget.ts',
      'theSuiteRunsFromTheServerDirectory.ts',
      'theSchedulerStopsBetweenTests.ts',
    ].map((file) => 'server/src/testing/' + file),
  ].sort()
);
export function correctiveIssuerControlFingerprint(
  local: (path: string) => Buffer,
  protectedBytes: (path: string) => Buffer
): string | null {
  try {
    const hash = createHash('sha256').update('horse-phase14-current-issuer-control-v1\0');
    let total = 0;
    for (const path of CORRECTIVE_ISSUER_CONTROL_FILES) {
      const a = local(path),
        b = protectedBytes(path);
      if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length > 2 * 1024 * 1024 || !a.equals(b))
        return null;
      total += a.length;
      if (total > 64 * 1024 * 1024) return null;
      hash.update(path + '\0' + a.length + ':').update(a);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
export function checkCurrentCorrectiveIssuerControl(
  mainSha: string
): Readonly<{ mainSha: string; fingerprint: string }> | null {
  if (!/^[a-f0-9]{40}$/.test(mainSha)) return null;
  try {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const git = (args: string[], timeout = 10000) =>
      execFileSync(
        'git',
        [
          '-c',
          'credential.helper=!gh auth git-credential',
          '--no-optional-locks',
          '-C',
          root,
          ...args,
        ],
        {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          env: correctiveReviewerChildEnvironment('github'),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    try {
      git(['cat-file', '-e', mainSha + '^{commit}']);
    } catch {
      git(
        [
          'fetch',
          '--no-tags',
          '--filter=blob:none',
          '--no-write-fetch-head',
          'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git',
          mainSha,
        ],
        30000
      );
    }
    const fingerprint = correctiveIssuerControlFingerprint(
      (path) => readFileSync(join(root, path)),
      (path) => git(['show', mainSha + ':' + path])
    );
    return fingerprint ? Object.freeze({ mainSha, fingerprint }) : null;
  } catch {
    return null;
  }
}
