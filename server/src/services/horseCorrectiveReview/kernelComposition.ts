import type { HorseAuthorityVerdict } from '../../engine/HorseQualifiedAuthority.js';

/** One baseline owner whose protected selection was included in the signed
 * corrective composition. The caller derives relevance from the original
 * variant/domain and supplies the owner's current S4 verdict; this function
 * neither loads authority nor grants it from a supplied mode. */
export interface CorrectiveBaselineCompositionRequirement {
  readonly selected: boolean;
  readonly callerMode: unknown;
  readonly verdict: HorseAuthorityVerdict;
}

/** A static protected-selection digest does not establish runtime usability.
 * A selected baseline owner must still be admitted and must not have been
 * disabled for this decision. Unselected owners impose no authority gate.
 * Use the same check at worker execution and main acceptance; a usable
 * corrective holder cannot substitute for a withdrawn baseline owner. */
export function correctiveBaselineCompositionIsUsable(
  requirements: readonly CorrectiveBaselineCompositionRequirement[]
): boolean {
  return requirements.every(
    (requirement) =>
      !requirement.selected ||
      (requirement.verdict === 'usable' &&
        (requirement.callerMode === undefined ||
          requirement.callerMode === 'shadow' ||
          requirement.callerMode === 'candidate'))
  );
}
