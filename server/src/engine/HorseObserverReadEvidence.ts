import { anchorHorseDecisionHand } from './HorseDecisionHandBinding.js';
import {
  horseObserverReadContextFromRequest,
  horseObserverReadContextKey,
} from './HorseObserverReadContext.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
export const HORSE_OBSERVER_READ_EVIDENCE_VERSION = 1;
/** Validates retained provenance only. It cannot establish runtime delivery,
 * full history coverage, poker strength or authority to activate a strategy. */
export function horseObserverReadsWereIndependent(
  value: unknown,
  request: LiveHorseDecisionSnapshot
): boolean {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    const keys = ['version', 'disposition', 'context', 'cutoffMs', 'learnedThroughMs', 'history'];
    const expected = horseObserverReadContextFromRequest(request);
    return (
      Object.keys(v).length === keys.length &&
      keys.every((key) => Object.hasOwn(v, key)) &&
      v.version === 1 &&
      v.disposition === 'independent' &&
      v.history === 'volatile_only' &&
      typeof v.cutoffMs === 'number' &&
      Number.isSafeInteger(v.cutoffMs) &&
      v.cutoffMs >= 0 &&
      v.cutoffMs === request.decisionTimeMs &&
      typeof v.learnedThroughMs === 'number' &&
      Number.isSafeInteger(v.learnedThroughMs) &&
      v.learnedThroughMs >= 0 &&
      v.learnedThroughMs <= v.cutoffMs &&
      expected !== null &&
      horseObserverReadContextKey(v.context) === horseObserverReadContextKey(expected) &&
      anchorHorseDecisionHand(request).status === 'anchored'
    );
  } catch {
    return false;
  }
}
