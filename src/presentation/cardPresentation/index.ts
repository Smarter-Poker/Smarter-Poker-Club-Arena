/**
 * SMARTER.POKER CARD PRESENTATION ENGINE (spec 130). Debuts with the river
 * squeeze; the engine, keys, profiles and resolver are street-generic so the
 * flop fan, turn slide, run-it-twice and showdown reveals plug into the same
 * pipeline later without redesigning it.
 */

export * from './types';
export * from './profiles';
export * from './animationKey';
export * from './resolveProfile';
export { CardPresentationEngine } from './CardPresentationEngine';
export type { ActivePresentationView } from './CardPresentationEngine';
export { createAnalyticsTelemetrySink, TELEMETRY_SAMPLE_RATE } from './telemetry';
export { SqueezeCard, squeezeHostProps, squeezeVars, type SqueezeCardProps } from './SqueezeCard';
export { useCardSqueeze, streetForCount, type CardSqueezeState } from './useCardSqueeze';
export { installEnvironmentInterrupts, RESIZE_SETTLE_MS } from './environmentInterrupts';
export { preloadImage, resetPreloadCache, preloadCount } from './preload';
export {
  DEGRADED_FPS_THRESHOLD,
  rafFrameSampler,
  noopFrameSampler,
  type FrameSample,
  type FrameSamplerStart,
} from './frameSampler';

export { cardPresentationEngine } from './engineSingleton';
