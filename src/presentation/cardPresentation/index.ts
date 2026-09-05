/**
 * SMARTER.POKER CARD PRESENTATION ENGINE (spec 130). Debuts with the river
 * squeeze; the engine, keys, profiles and resolver are street-generic so the
 * flop fan, turn slide, run-it-twice and showdown reveals plug into the same
 * pipeline later without redesigning it.
 */

import { CardPresentationEngine } from './CardPresentationEngine';
import { createAnalyticsTelemetrySink } from './telemetry';
import { getAnimationSpeed } from '../../utils/animationSpeed';

export * from './types';
export * from './profiles';
export * from './animationKey';
export * from './resolveProfile';
export { CardPresentationEngine } from './CardPresentationEngine';
export type { ActivePresentationView } from './CardPresentationEngine';
export { createAnalyticsTelemetrySink, TELEMETRY_SAMPLE_RATE } from './telemetry';

/** The one engine every board on the client shares. */
export const cardPresentationEngine = new CardPresentationEngine({
  telemetry: createAnalyticsTelemetrySink(),
  speed: getAnimationSpeed,
});
