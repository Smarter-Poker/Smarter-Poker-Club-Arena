/**
 * The one engine every surface shares - the felt board, the hand replay, the
 * debug overlay.
 *
 * ROUND 2 2026-09-05: it lives in its OWN module, not in index.ts. The hook
 * and the debug overlay both need the singleton and are both re-exported by
 * the barrel, so importing it from the barrel made a cycle
 * (index -> useCardSqueeze -> index). ESM tolerates that until the day an
 * evaluation order changes and the singleton is `undefined` at first use.
 */

import { CardPresentationEngine } from './CardPresentationEngine';
import { createAnalyticsTelemetrySink } from './telemetry';
import { getAnimationSpeed } from '../../utils/animationSpeed';

export const cardPresentationEngine = new CardPresentationEngine({
  telemetry: createAnalyticsTelemetrySink(),
  speed: getAnimationSpeed,
});
