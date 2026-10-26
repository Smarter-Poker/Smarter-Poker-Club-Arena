/** Immutable source release data; no network or polling on the action path.
 * The source helper is copied with src/, including for compiled engine code. */
import type { HorseAuthorityEvidenceReader } from '../../engine/HorseQualifiedAuthority.js';
import { repositoryEvidenceReader } from '../../engine/HorseQualifiedAuthority.js';
import { CORRECTIVE_DOMAIN_KEYS } from './domain.js';
export {
  PHASE14_GENERATION_LEDGER_PATH,
  parsePhase14GenerationLedger,
  phase14SelectionIdentityDigest,
  phase14LedgerSelectionAllowed,
  phase14GenerationTransitionAllowed,
} from '../../../src/services/horseCorrectiveReview/kernelGenerationLedgerRules.mjs';
import {
  PHASE14_GENERATION_LEDGER_PATH,
  PHASE14_GENERATION_DOMAINS,
  parsePhase14GenerationLedger,
  type Phase14GenerationLedger,
} from '../../../src/services/horseCorrectiveReview/kernelGenerationLedgerRules.mjs';
export function readPhase14GenerationLedger(
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader
): Phase14GenerationLedger | null {
  try {
    if ([...CORRECTIVE_DOMAIN_KEYS].sort().join(',') !== PHASE14_GENERATION_DOMAINS.join(','))
      return null;
    const bytes = reader.read(PHASE14_GENERATION_LEDGER_PATH);
    return bytes.length <= 512 * 1024
      ? parsePhase14GenerationLedger(JSON.parse(bytes.toString('utf8')))
      : null;
  } catch {
    return null;
  }
}
