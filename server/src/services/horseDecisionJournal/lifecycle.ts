import {
  anchorHorseDecisionHand,
  horseHandAnchorKey,
} from '../../engine/HorseDecisionHandBinding.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type DeepHorseDecisionRequest,
  type DecidePineappleDiscardRequest,
} from '../../engine/horseDecision/protocol.js';
import { horseDiscardHandKey, horseDiscardTurnKey } from './discard.js';
import { horseJournalJson, journalHash } from './record.js';

export type HorseLifecycleRequest =
  | FastHorseDecisionRequest
  | DeepHorseDecisionRequest
  | DecidePineappleDiscardRequest;
export type HorseLifecycleOutcome = 'success' | 'refused' | 'cancelled' | 'expired' | 'exception';
export type HorseLifecycleOrigin = 'worker_compute' | 'client_not_dispatched';
export type HorseRequestLifecycle =
  | {
      version: 1;
      phase: 'requested';
      request: HorseLifecycleRequest;
      requestDigest: string;
      origin: HorseLifecycleOrigin;
    }
  | { version: 1; phase: 'terminal'; requestDigest: string; outcome: HorseLifecycleOutcome };

export const isHorseLifecycleRequest = (request: {
  type: string;
}): request is HorseLifecycleRequest =>
  ['DECIDE_FAST', 'DECIDE_DEEP', 'DECIDE_DISCARD'].includes(request.type);
export const horseLifecycleRequestDigest = (request: HorseLifecycleRequest): string =>
  journalHash(horseJournalJson(request));
export function horseLifecycleKeys(request: HorseLifecycleRequest): { hand: string; turn: string } {
  if (request.type === 'DECIDE_DISCARD') {
    const hand = horseDiscardHandKey(request);
    if (!hand) throw Error('Horse lifecycle attribution unavailable');
    return { hand, turn: horseDiscardTurnKey(request) };
  }
  if (
    !Number.isSafeInteger(request.requestId) ||
    request.requestId < 1 ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(request.decisionTimeMs) ||
    request.decisionTimeMs < 0 ||
    request.decisionKey !== buildHorseDecisionKey(request) ||
    (request.type === 'DECIDE_DEEP' &&
      (!Number.isInteger(request.rngBefore) ||
        request.rngBefore < 0 ||
        request.rngBefore > 0xffffffff ||
        !Number.isFinite(request.deepEquity) ||
        request.deepEquity <= 1))
  )
    throw Error('Horse lifecycle identity invalid');
  const anchor = anchorHorseDecisionHand(request);
  if (anchor.status !== 'anchored') throw Error('Horse lifecycle attribution unavailable');
  return {
    hand: horseHandAnchorKey(anchor),
    turn: JSON.stringify([
      request.generation,
      request.fence,
      request.requestId,
      request.decisionKey,
      request.decisionTimeMs,
    ]),
  };
}

export function validateHorseRequestLifecycle(
  value: unknown
): asserts value is HorseRequestLifecycle {
  const row = value as HorseRequestLifecycle;
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    row.version !== 1 ||
    typeof row.requestDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.requestDigest)
  )
    throw Error('Invalid Horse request lifecycle');
  if (row.phase === 'requested') {
    if (
      Object.keys(row).length !== 5 ||
      !row.request ||
      !isHorseLifecycleRequest(row.request) ||
      !['worker_compute', 'client_not_dispatched'].includes(row.origin) ||
      horseLifecycleRequestDigest(row.request) !== row.requestDigest
    )
      throw Error('Invalid Horse request admission');
    horseLifecycleKeys(row.request);
  } else if (
    row.phase !== 'terminal' ||
    Object.keys(row).length !== 4 ||
    !['success', 'refused', 'cancelled', 'expired', 'exception'].includes(row.outcome)
  ) {
    throw Error('Invalid Horse request terminal');
  }
}
