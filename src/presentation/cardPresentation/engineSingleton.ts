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
import { installEnvironmentInterrupts } from './environmentInterrupts';

export const cardPresentationEngine = new CardPresentationEngine({
  telemetry: createAnalyticsTelemetrySink(),
  speed: getAnimationSpeed,
});

/**
 * PHASE 2 2026-09-05: a resize, an orientation change or the tab going into
 * the background all invalidate a flip already in flight. Installed once,
 * here, beside the singleton it protects - a per-board listener would add one
 * resize handler per table on a multi-tabling client and they would all do the
 * same thing. Guarded for SSR and for the test environment.
 */
installEnvironmentInterrupts(cardPresentationEngine);
