/** Exact running policy composition for the original-state corrective kernel.
 * Protected baseline selections are bound separately, so selecting another
 * qualified owner invalidates an earlier corrective composition. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  HORSE_PHASE10_POLICY_SOURCE_FILES,
  PHASE10_PROTECTED_RELEASE_SELECTION,
} from '../../engine/HorsePhase10Authority.js';
import { HORSE_PHASE11_POLICY_SOURCE_FILES } from '../../engine/HorsePhase11PolicyDigest.js';
import { HORSE_PHASE12_POLICY_SOURCE_FILES } from '../../engine/HorsePhase12PolicyDigest.js';
import { HORSE_PHASE13_POLICY_SOURCE_FILES } from '../../engine/HorsePhase13PolicyDigest.js';
import { PHASE8_PROTECTED_RELEASE_SELECTION } from '../../engine/HorseQualifiedAuthority.js';
import { PHASE11_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase11Authority.js';
import { PHASE12_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase12Authority.js';
import { PHASE13_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase13Authority.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
export const CORRECTIVE_KERNEL_POLICY_DIGEST_DEFINITION = 'horse-phase14-kernel-policy-digest-v1';
export const CORRECTIVE_KERNEL_POLICY_SOURCE_FILES: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...HORSE_PHASE10_POLICY_SOURCE_FILES,
      ...HORSE_PHASE11_POLICY_SOURCE_FILES,
      ...HORSE_PHASE12_POLICY_SOURCE_FILES,
      ...HORSE_PHASE13_POLICY_SOURCE_FILES,
      'src/engine/HorseLogic.ts',
      'src/engine/HorsePolicyGraph.ts',
      'src/engine/HorsePolicyRegistry.ts',
      'src/engine/HorseDecisionEffects.ts',
      'src/engine/HorseDecisionReadFrame.ts',
      'src/engine/HorseExecutionWitness.ts',
      'src/engine/HorseObservationIdentity.ts',
      'src/engine/HorseDecisionHandBinding.ts',
      'src/engine/HorsePlanEffectReceipt.ts',
      'src/engine/HorseTournamentPostflop.ts',
      'src/engine/HorseTournamentContinuation.ts',
      'src/engine/HorsePhase8Safety.ts',
      'src/engine/HorsePhase14Acceptance.ts',
      'src/engine/HorsePhase14Authority.ts',
      'src/engine/HorseQualifiedAuthority.ts',
      'src/engine/HorsePhase6Attribution.ts',
      'src/engine/horseDecision/replay/runtimeReplay.ts',
      'src/engine/horseDecision/replay/qualifiedAuthority.ts',
      'src/engine/horseDecision/replay/exactReplay.ts',
      'src/engine/horseDecision/replay/reconstruct.ts',
      'src/services/horseDecisionJournal/review.ts',
      'src/services/horseDecisionJournal/effects.ts',
      'src/engine/horseDecision/workerRuntime.ts',
      'src/engine/horseDecision/client.ts',
      'src/engine/horseDecision/protocol.ts',
      'src/engine/horseDecision/responseValidation.ts',
      'src/engine/horseDecision/replayState.ts',
      'src/engine/ServerTableEngineTurns.ts',
      'src/lightning/LightningHandHost.ts',
      'src/services/horseCorrectiveReview/riverReference.ts',
      'src/services/horseCorrectiveReview/riverDecisionModel.ts',
      'src/services/horseCorrectiveReview/riverKernel.ts',
      'src/services/horseCorrectiveReview/kernelApproval.ts',
      'src/services/horseCorrectiveReview/kernelCatalog.ts',
      'src/services/horseCorrectiveReview/kernelAdmission.ts',
      'src/services/horseCorrectiveReview/kernelGenerationLedger.ts',
      'src/services/horseCorrectiveReview/kernelGenerationLedgerRules.mjs',
      'src/services/horseCorrectiveReview/kernelGenerationLedgerRules.d.mts',
      'src/services/horseCorrectiveReview/liveKernel.ts',
      'src/services/horseCorrectiveReview/kernelReceipt.ts',
      'src/services/horseCorrectiveReview/kernelDefinition.ts',
      'src/services/horseCorrectiveReview/kernelEligibility.ts',
      'src/services/horseCorrectiveReview/kernelOriginalInput.ts',
      'src/services/horseCorrectiveReview/kernelComposition.ts',
      'src/services/horseCorrectiveReview/kernelPolicyDigest.ts',
      'src/services/horseCorrectiveReview/domain.ts',
      'src/services/horseCorrectiveReview/eligibility.ts',
      'src/services/horseCorrectiveReview/review.ts',
      'src/services/horseCorrectiveReview/authority.ts',
      'src/services/horseDecisionJournal/record.ts',
      'src/types.ts',
    ]),
  ].sort()
);
export type CorrectiveKernelSourceReader = (serverRelativePath: string) => Buffer;
export function correctiveKernelPolicyDigestOf(read: CorrectiveKernelSourceReader): string | null {
  const hash = createHash('sha256').update(CORRECTIVE_KERNEL_POLICY_DIGEST_DEFINITION + '\0');
  try {
    for (const path of CORRECTIVE_KERNEL_POLICY_SOURCE_FILES) {
      const bytes = read(path);
      if (!Buffer.isBuffer(bytes)) return null;
      // Length-delimited fields prevent a source containing separators from
      // masquerading as a different file boundary.
      hash.update(String(Buffer.byteLength(path)) + ':' + path + ':' + bytes.length + ':');
      hash.update(bytes);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
let running: string | null | undefined;
export function correctiveKernelPolicyDigest(): string | null {
  if (running === undefined)
    running = correctiveKernelPolicyDigestOf((path) =>
      readFileSync(new URL('../../../' + path, import.meta.url))
    );
  return running;
}
/** Called lazily, after module initialization; no eager selection snapshot. */
export function correctiveKernelBaselineSelectionsDigest(): string {
  return createHash('sha256')
    .update('horse-phase14-baseline-selections-v1\0')
    .update(
      horseJournalJson({
        phase8: PHASE8_PROTECTED_RELEASE_SELECTION,
        phase10: PHASE10_PROTECTED_RELEASE_SELECTION,
        phase11: PHASE11_PROTECTED_RELEASE_SELECTIONS,
        phase12: PHASE12_PROTECTED_RELEASE_SELECTIONS,
        phase13: PHASE13_PROTECTED_RELEASE_SELECTIONS,
      })
    )
    .digest('hex');
}
