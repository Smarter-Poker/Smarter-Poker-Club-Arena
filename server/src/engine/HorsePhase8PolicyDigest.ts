import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HORSE_REFERENCE_DECISION_SOURCE_FILES } from './HorseReferenceDecisionSources.js';

/** Changed read ownership must invalidate prior tournament qualification too. */
export const HORSE_PHASE8_POLICY_DIGEST_DEFINITION = 'horse-phase8-policy-digest-v2';
export const HORSE_PHASE8_POLICY_SOURCE_FILES = Object.freeze([
  ...new Set([
    'src/engine/HorseLogic.ts',
    'src/engine/HorseEval.ts',
    'src/engine/PokerEngine.ts',
    'src/engine/HorseFiveCardScore.ts',
    'src/engine/HorsePolicyRegistry.ts',
    'src/engine/EquityLoadGovernor.ts',
    'src/engine/HorseTournamentContinuation.ts',
    'src/engine/HorseTournamentFutureGame.ts',
    'src/engine/HorseTournamentFutureHand.ts',
    'src/engine/HorseTournamentUtilityEvidence.ts',
    'src/engine/HorseTournamentContextProvenance.ts',
    ...HORSE_REFERENCE_DECISION_SOURCE_FILES,
  ]),
]);
export const runningPhase8PolicySourceReader = (path: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));
export function horsePhase8SourceBoundDigest(
  boundaries: string,
  read: (path: string) => Buffer = runningPhase8PolicySourceReader
): string {
  const hash = createHash('sha256').update(
    `${HORSE_PHASE8_POLICY_DIGEST_DEFINITION}\0${boundaries}\0`
  );
  for (const file of HORSE_PHASE8_POLICY_SOURCE_FILES)
    hash.update(`${file}\0`).update(read(file)).update('\0');
  return hash.digest('hex');
}
