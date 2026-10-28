import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HORSE_PHASE8_POLICY_SOURCE_FILES } from './HorsePhase8PolicyDigest.js';

/** Selector metadata is bound by the protected release, never by its own policy hash. */
export const HORSE_CATASTROPHE_GUARD_POLICY_SOURCE_FILES = Object.freeze([
  ...new Set([
    ...HORSE_PHASE8_POLICY_SOURCE_FILES,
    'src/engine/HorsePhase8PolicyDigest.ts',
    'src/engine/HorseReferenceDecisionSources.ts',
    'src/engine/HorseQualifiedAuthority.ts',
    'src/engine/HorseCatastropheGuardPolicyDigest.ts',
    'src/engine/HorseTournamentCatastropheGuard.ts',
    'src/engine/HorseTournamentCatastropheGuardAuthority.ts',
    'src/engine/HorsePhase14Authority.ts',
    'src/services/horseCorrectiveReview/kernelPolicyDigest.ts',
    'src/services/horseCorrectiveReview/liveKernel.ts',
    'src/services/horseCorrectiveReview/kernelReceipt.ts',
    'src/engine/HorsePhase8GuardAcceptance.ts',
    'src/engine/HorseQualifiedAcceptance.ts',
    'src/engine/HorseExecutionWitness.ts',
    'src/engine/ServerTableEngineTurns.ts',
    'src/engine/horseDecision/protocol.ts',
    'src/engine/horseDecision/responseValidation.ts',
    'src/engine/horseDecision/replayState.ts',
    'src/engine/horseDecision/replay/qualifiedAuthority.ts',
    'src/engine/horseDecision/replay/runtimeReplay.ts',
    'src/engine/horseDecision/replay/exactReplay.ts',
    'src/engine/horseDecision/replay/HorseDecisionReplay.ts',
    'src/engine/horseDecision/replay/v56Counterfactual.ts',
    'src/types.ts',
    'src/services/horseDecisionJournal/review.ts',
    'src/services/horseDecisionJournal/phaseProof.ts',
    'src/services/horseDecisionJournal/fleet.ts',
  ]),
]);
export const runningCatastropheGuardPolicySourceReader = (path: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));
export function horseCatastropheGuardPolicyDigest(
  read = runningCatastropheGuardPolicySourceReader
): string {
  const hash = createHash('sha256').update('horse-catastrophe-guard-runtime-policy-v1\0');
  for (const path of HORSE_CATASTROPHE_GUARD_POLICY_SOURCE_FILES)
    hash
      .update(path + '\0')
      .update(read(path))
      .update('\0');
  return hash.digest('hex');
}
