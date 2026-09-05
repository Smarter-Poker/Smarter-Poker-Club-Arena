/**
 * RIVER SQUEEZE 2026-09-04 (spec 14, 31). Every presentation has an immutable
 * identity, and that identity is the HAND INSTANCE on a TABLE, not the street
 * alone. A fast-fold player who leaves hand A mid-river and is dealt hand B
 * must never see A's river animate on B's board; two boards in a bomb pot must
 * never share a key; a duplicate snapshot must not animate twice.
 */

import type { CommunityCardDealPresentation, CommunityStreet } from './types';

export function buildAnimationKey(e: CommunityCardDealPresentation): string {
  return `table:${e.tableId}/hand:${String(e.handId)}/board:${e.boardIndex}/street:${e.street}/slot:${e.slotIndex}`;
}

/** The per-table-per-board lane a new presentation pre-empts (spec 102). */
export function laneKey(e: Pick<CommunityCardDealPresentation, 'tableId' | 'boardIndex'>): string {
  return `table:${e.tableId}/board:${e.boardIndex}`;
}

export const STREET_ORDER: Readonly<Record<CommunityStreet, number>> = Object.freeze({
  flop: 1,
  turn: 2,
  river: 3,
});

/**
 * hand_number is numeric on the wire; a non-numeric id is compared as a plain
 * string so an unknown scheme is never mistaken for "older".
 */
export function isOlderHand(candidate: string | number, latest: string | number): boolean {
  const a = Number(candidate);
  const b = Number(latest);
  if (Number.isFinite(a) && Number.isFinite(b)) return a < b;
  return false;
}
