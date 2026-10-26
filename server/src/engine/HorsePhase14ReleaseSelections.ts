/** Protected release data, kept separate from the code its qualification binds. */
import type { HorsePhase14AuthoritySelection } from './HorsePhase14Authority.js';
import { CORRECTIVE_DOMAIN_KEYS } from '../services/horseCorrectiveReview/domain.js';
/**
 * THE PROTECTED RELEASE SELECTIONS, one per corrective domain. All null: no
 * real independently signed functional holdout has been installed,
 * so the built corrective consumer remains unselected.
 */
export const PHASE14_PROTECTED_RELEASE_SELECTIONS: Readonly<
  Record<string, HorsePhase14AuthoritySelection | null>
> = Object.freeze(Object.fromEntries(CORRECTIVE_DOMAIN_KEYS.map((domain) => [domain, null])));
