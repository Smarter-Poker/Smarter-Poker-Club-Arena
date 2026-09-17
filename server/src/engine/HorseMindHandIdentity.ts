import {
  horseCompletedHandKey,
  horseJournalLeaseIdentityIsValid,
} from './HorseDecisionHandBinding.js';
import type { CompletedHandObservation } from './horseDecision/protocol.js';

/** Local basic-read coordinate from the existing allocated hand number.
 * It is not the accepted hand UUID, an action receipt or learning authority. */
export interface HorseMindHandIdentity {
  readonly version: 1;
  readonly tableId: string;
  readonly handNumber: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonicalUint = /^(0|[1-9][0-9]*)$/;

export function horseMindHandIdentity(
  tableId: unknown,
  handNumber: unknown
): HorseMindHandIdentity | null {
  if (
    typeof tableId !== 'string' ||
    !UUID.test(tableId) ||
    !Number.isSafeInteger(handNumber) ||
    (handNumber as number) < 1000000
  )
    return null;
  return Object.freeze({
    version: 1,
    tableId: tableId.toLowerCase(),
    handNumber: handNumber as number,
  });
}

export function horseMindHandIdentityKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !Object.hasOwn(v, 'version') ||
    v.version !== 1 ||
    Object.keys(v).length !== 3 ||
    !Object.hasOwn(v, 'tableId') ||
    !Object.hasOwn(v, 'handNumber')
  )
    return null;
  const identity = horseMindHandIdentity(v.tableId, v.handNumber);
  return identity ? `mind-hand-v1:${identity.tableId}:${identity.handNumber}` : null;
}

/** The producer's exact five parts are table, hand, actor seat, lease, turn.
 * Seat/turn are checked against their separately supplied request values.
 * Lease shape is not proof of a current lease; the existing producer fence
 * owns that permission. No coordinates are recovered from arbitrary hashes. */
export function horseMindHandFromDecision(request: {
  fence: string;
  generation: number;
  player: { seat: number };
}): HorseMindHandIdentity | null {
  const parts = typeof request.fence === 'string' ? request.fence.split(':') : [];
  if (
    parts.length !== 5 ||
    !canonicalUint.test(parts[1]!) ||
    !canonicalUint.test(parts[2]!) ||
    !canonicalUint.test(parts[4]!) ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(request.player?.seat) ||
    request.player.seat < 1 ||
    request.player.seat > 10 ||
    Number(parts[2]) !== request.player.seat ||
    Number(parts[4]) !== request.generation ||
    !horseJournalLeaseIdentityIsValid(parts[3])
  )
    return null;
  return horseMindHandIdentity(parts[0], Number(parts[1]));
}

/** The accepted producer already checks this four-part fence against handKey
 * and generation. The returned database UUID must exist but is not substituted
 * into the earlier decision's coordinate. Legacy low numbers remain unavailable. */
export function horseMindHandFromCompletion(
  request: CompletedHandObservation
): HorseMindHandIdentity | null {
  if (
    typeof request.committedHandId !== 'string' ||
    !UUID.test(request.committedHandId) ||
    !horseCompletedHandKey(request)
  )
    return null;
  const parts = request.fence.split(':');
  return horseMindHandIdentity(parts[0], Number(parts[1]));
}

/** Reads only actual retained columns. A UUID or timestamp cannot reconstruct
 * a missing table/allocated number. This helper does not certify the DB source. */
export function horseMindHandFromHistory(row: {
  id?: unknown;
  table_id?: unknown;
  hand_number?: unknown;
}): HorseMindHandIdentity | null {
  if (typeof row.id !== 'string' || !UUID.test(row.id)) return null;
  return horseMindHandIdentity(row.table_id, row.hand_number);
}
