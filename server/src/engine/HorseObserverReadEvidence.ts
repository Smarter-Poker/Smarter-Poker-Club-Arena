import { anchorHorseDecisionHand } from './HorseDecisionHandBinding.js';
import {
  horseObserverReadContextFromRequest,
  horseObserverReadContextKey,
} from './HorseObserverReadContext.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
export const HORSE_OBSERVER_READ_EVIDENCE_VERSION = 2;
/** Validates retained provenance only. It cannot establish runtime delivery,
 * full history coverage, poker strength or authority to activate a strategy. */
export function horseObserverReadsWereIndependent(
  value: unknown,
  request: LiveHorseDecisionSnapshot
): boolean {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    const keys = [
      'version',
      'disposition',
      'context',
      'cutoffMs',
      'learnedThroughMs',
      'history',
      ...(v.version === 2
        ? ['historyDigest', 'historyAvailableAtMs', 'historyHands', 'historyCapped']
        : []),
    ];
    const historyValid =
      v.version === 1
        ? v.history === 'volatile_only'
        : v.version === 2 &&
          v.history === 'own_public_window' &&
          typeof v.historyDigest === 'string' &&
          /^[a-f0-9]{64}$/.test(v.historyDigest) &&
          typeof v.historyAvailableAtMs === 'number' &&
          Number.isSafeInteger(v.historyAvailableAtMs) &&
          v.historyAvailableAtMs >= 0 &&
          typeof v.learnedThroughMs === 'number' &&
          v.historyAvailableAtMs <= v.learnedThroughMs &&
          Number.isSafeInteger(v.historyHands) &&
          (v.historyHands as number) >= 0 &&
          (v.historyHands as number) <= 64 &&
          typeof v.historyCapped === 'boolean';
    const expected = horseObserverReadContextFromRequest(request);
    return (
      Object.keys(v).length === keys.length &&
      keys.every((key) => Object.hasOwn(v, key)) &&
      historyValid &&
      v.disposition === 'independent' &&
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
