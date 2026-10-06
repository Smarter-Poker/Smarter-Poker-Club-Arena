import type { HandRow } from './types';

export interface NotableHandsRequest {
  targetUserId: string;
  clubId: string | null;
  asset: 'chips' | 'diamonds';
  visibility: 'owner';
}

const POSTGRES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const validDateTime = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0;

const exactMoney = (value: unknown, nonnegative = false): value is number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) {
    return false;
  }
  const cents = value * 100;
  return Number.isSafeInteger(Math.round(cents)) && Math.abs(cents - Math.round(cents)) <= 1e-6;
};

const cardArrayOrNull = (value: unknown): value is string[] | null =>
  value === null ||
  (Array.isArray(value) &&
    value.every((card) => typeof card === 'string' && card.trim().length > 0));

/**
 * Parse the owner-only notable-hands v2 envelope without inventing evidence.
 *
 * This contract is Analysis-only and intentionally lives behind that tab's
 * existing lazy boundary. The Overview route does not parse or download an
 * evidence envelope it cannot render.
 */
export function normalizeHands(data: unknown, request: NotableHandsRequest): HandRow[] | null {
  const payload = record(data);
  const scope = record(payload?.scope);
  const rows = payload?.hands;
  if (
    !payload ||
    payload.contract_version !== 2 ||
    !scope ||
    scope.target_user_id !== request.targetUserId ||
    scope.club_id !== request.clubId ||
    scope.asset !== request.asset ||
    scope.visibility !== request.visibility ||
    !validDateTime(payload.generated_at) ||
    !Array.isArray(rows) ||
    rows.length > 100
  ) {
    return null;
  }

  const normalized: HandRow[] = [];
  const ids = new Set<string>();
  for (const value of rows) {
    const hand = record(value);
    if (
      !hand ||
      typeof hand.id !== 'string' ||
      !POSTGRES_UUID.test(hand.id) ||
      ids.has(hand.id) ||
      !validDateTime(hand.played_at) ||
      typeof hand.variant !== 'string' ||
      hand.variant.trim().length === 0 ||
      !exactMoney(hand.big_blind, true) ||
      hand.big_blind <= 0 ||
      typeof hand.is_tournament !== 'boolean' ||
      !(
        hand.position === null ||
        (typeof hand.position === 'string' && hand.position.trim().length > 0)
      ) ||
      !exactMoney(hand.pot_size, true) ||
      !exactMoney(hand.won, true) ||
      !exactMoney(hand.profit) ||
      typeof hand.is_winner !== 'boolean' ||
      !nonnegativeInteger(hand.players) ||
      hand.players < 1 ||
      !cardArrayOrNull(hand.board) ||
      !cardArrayOrNull(hand.hole_cards)
    ) {
      return null;
    }
    ids.add(hand.id);
    normalized.push({
      id: hand.id,
      played_at: hand.played_at,
      variant: hand.variant,
      big_blind: hand.big_blind,
      is_tournament: hand.is_tournament,
      position: hand.position as string | null,
      pot_size: hand.pot_size,
      won: hand.won,
      profit: hand.profit,
      is_winner: hand.is_winner,
      players: hand.players,
      board: hand.board as string[] | null,
      hole_cards: hand.hole_cards as string[] | null,
    });
  }
  return normalized;
}
