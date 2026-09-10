import { uuidShape } from '../lib/uuidShape.js';
export type SatelliteTicketDeliveryKind = 'seat' | 'cash' | 'ticket';

export interface SatelliteSettlementAward {
  user_id?: unknown;
  position?: unknown;
  amount?: unknown;
  delivery_kind?: unknown;
  payout_id?: unknown;
  registration_id?: unknown;
  ticket_id?: unknown;
}

export interface SatelliteSettlementSeat {
  user_id?: unknown;
  position?: unknown;
  amount?: unknown;
  registration_id?: unknown;
}

export interface SatelliteSettlementRemainder {
  user_id?: unknown;
  position?: unknown;
  amount?: unknown;
}

export interface SatelliteSourceCloseout {
  source_table_count?: unknown;
  source_table_ids?: unknown;
  source_seat_count?: unknown;
  source_seat_ids?: unknown;
  released_seat_count?: unknown;
  released_seat_ids?: unknown;
  closed_at?: unknown;
}

export interface SatelliteSettlementReceipt {
  receipt_version?: unknown;
  ok?: unknown;
  fully_settled?: unknown;
  status?: unknown;
  reason?: unknown;
  tournament_id?: unknown;
  target_id?: unknown;
  winner_id?: unknown;
  field_size?: unknown;
  pool?: unknown;
  ticket_cost?: unknown;
  ticket_award_count?: unknown;
  seat_count?: unknown;
  cash_ticket_count?: unknown;
  entry_ticket_count?: unknown;
  awards?: unknown;
  seats?: unknown;
  remainder?: unknown;
  winner_amount?: unknown;
  source_table_count?: unknown;
  source_seat_count?: unknown;
  released_seat_count?: unknown;
  source_closeout?: unknown;
  settled_at?: unknown;
}

export interface VerifiedSatelliteSettlementReceipt {
  receiptVersion: 2;
  tournamentId: string;
  targetId: string;
  winnerId: string;
  fieldSize: number;
  pool: number;
  ticketCost: number;
  ticketAwardCount: number;
  seatCount: number;
  cashTicketCount: number;
  entryTicketCount: number;
  awards: Array<
    {
      userId: string;
      position: number;
      amount: number;
      payoutId: string;
    } & (
      | { deliveryKind: 'seat'; registrationId: string; ticketId: null }
      | { deliveryKind: 'cash'; registrationId: null; ticketId: null }
      | { deliveryKind: 'ticket'; registrationId: null; ticketId: string }
    )
  >;
  seats: Array<{
    userId: string;
    position: number;
    amount: number;
    registrationId: string;
  }>;
  remainder: {
    userId: string;
    position: number;
    amount: number;
  } | null;
  winnerAmount: number;
  sourceCloseout: {
    sourceTableCount: number;
    sourceTableIds: string[];
    sourceSeatCount: number;
    sourceSeatIds: string[];
    releasedSeatCount: number;
    releasedSeatIds: string[];
    closedAt: string;
  };
  settledAt: string;
}

/**
 * PostgREST normally decodes jsonb, while older clients can return the same
 * value as a JSON string. A malformed response is never a settlement receipt.
 */
export function parseSatelliteSettlementReceipt(value: unknown): SatelliteSettlementReceipt {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as SatelliteSettlementReceipt) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as SatelliteSettlementReceipt) : {};
}

function finiteNumericTransport(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function exactCents(value: unknown): number | null {
  const amount = finiteNumericTransport(value);
  if (amount === null || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) < 1e-7 ? cents : null;
}

function positiveInteger(value: unknown): number | null {
  const number = finiteNumericTransport(value);
  if (number === null) return null;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumericTransport(value);
  if (number === null) return null;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

const RFC3339_TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function canonicalTimestamptz(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_TIMESTAMPTZ.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return null;

  return Number.isFinite(Date.parse(value)) ? value : null;
}

function uuid(value: unknown): string | null {
  return uuidShape(value);
}

function uniqueUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(uuid);
  if (ids.some((id) => id === null)) return null;
  const exact = ids as string[];
  return new Set(exact).size === exact.length ? exact : null;
}

/**
 * TypeScript never decides admission or satellite arithmetic. It proves the
 * database returned one internally consistent, terminal receipt before the
 * engine stops its in-memory tables or tells players they were paid. Every
 * full ticket is explicit as an actual target seat, an exact cash
 * substitution, or a target-scoped noncash tournament ticket.
 */
export function verifySatelliteSettlementReceipt(
  raw: unknown,
  expectedTournamentId: string,
  expectedWinnerId: string
): VerifiedSatelliteSettlementReceipt | null {
  const receipt = parseSatelliteSettlementReceipt(raw);
  const tournamentId = uuid(receipt.tournament_id);
  const targetId = uuid(receipt.target_id);
  const winnerId = uuid(receipt.winner_id);
  const fieldSize = positiveInteger(receipt.field_size);
  const ticketAwardCount = nonNegativeInteger(receipt.ticket_award_count);
  const seatCount = nonNegativeInteger(receipt.seat_count);
  const cashTicketCount = nonNegativeInteger(receipt.cash_ticket_count);
  const entryTicketCount = nonNegativeInteger(receipt.entry_ticket_count);
  const poolCents = exactCents(receipt.pool);
  const ticketCents = exactCents(receipt.ticket_cost);
  const winnerCents = exactCents(receipt.winner_amount);
  const sourceTableCount = positiveInteger(receipt.source_table_count);
  const sourceSeatCount = nonNegativeInteger(receipt.source_seat_count);
  const releasedSeatCount = nonNegativeInteger(receipt.released_seat_count);
  const settledAt = canonicalTimestamptz(receipt.settled_at);
  const rawCloseout =
    receipt.source_closeout && typeof receipt.source_closeout === 'object'
      ? (receipt.source_closeout as SatelliteSourceCloseout)
      : null;
  const sourceTableIds = uniqueUuidArray(rawCloseout?.source_table_ids);
  const sourceSeatIds = uniqueUuidArray(rawCloseout?.source_seat_ids);
  const releasedSeatIds = uniqueUuidArray(rawCloseout?.released_seat_ids);
  const closeoutTableCount = positiveInteger(rawCloseout?.source_table_count);
  const closeoutSeatCount = nonNegativeInteger(rawCloseout?.source_seat_count);
  const closeoutReleasedCount = nonNegativeInteger(rawCloseout?.released_seat_count);
  const closedAt = canonicalTimestamptz(rawCloseout?.closed_at);

  if (
    receipt.receipt_version !== 2 ||
    receipt.ok !== true ||
    receipt.fully_settled !== true ||
    receipt.status !== 'COMPLETED' ||
    tournamentId !== expectedTournamentId ||
    winnerId !== expectedWinnerId ||
    !targetId ||
    fieldSize === null ||
    ticketAwardCount === null ||
    seatCount === null ||
    cashTicketCount === null ||
    entryTicketCount === null ||
    ticketAwardCount !== seatCount + cashTicketCount + entryTicketCount ||
    ticketAwardCount > fieldSize ||
    poolCents === null ||
    ticketCents === null ||
    ticketCents <= 0 ||
    winnerCents === null ||
    sourceTableCount === null ||
    sourceSeatCount === null ||
    releasedSeatCount === null ||
    closeoutTableCount !== sourceTableCount ||
    closeoutSeatCount !== sourceSeatCount ||
    closeoutReleasedCount !== releasedSeatCount ||
    sourceTableIds === null ||
    sourceTableIds.length !== sourceTableCount ||
    sourceSeatIds === null ||
    sourceSeatIds.length !== sourceSeatCount ||
    releasedSeatIds === null ||
    releasedSeatIds.length !== releasedSeatCount ||
    releasedSeatIds.some((id) => !sourceSeatIds.includes(id)) ||
    closedAt === null ||
    settledAt === null ||
    Date.parse(closedAt) > Date.parse(settledAt) ||
    !Array.isArray(receipt.awards) ||
    receipt.awards.length !== ticketAwardCount ||
    !Array.isArray(receipt.seats) ||
    receipt.seats.length !== seatCount
  ) {
    return null;
  }

  const awards: VerifiedSatelliteSettlementReceipt['awards'] = [];
  const awardUsers = new Set<string>();
  const positions = new Set<number>();
  const payoutIds = new Set<string>();
  const registrationIds = new Set<string>();
  const ticketIds = new Set<string>();
  let observedSeats = 0;
  let observedCash = 0;
  let observedTickets = 0;

  for (const candidate of receipt.awards as SatelliteSettlementAward[]) {
    const userId = uuid(candidate?.user_id);
    const position = positiveInteger(candidate?.position);
    const amountCents = exactCents(candidate?.amount);
    const deliveryKind = candidate?.delivery_kind;
    const payoutId = uuid(candidate?.payout_id);
    const registrationId = uuid(candidate?.registration_id);
    const ticketId = uuid(candidate?.ticket_id);
    if (
      !userId ||
      position === null ||
      position > ticketAwardCount ||
      amountCents !== ticketCents ||
      (deliveryKind !== 'seat' && deliveryKind !== 'cash' && deliveryKind !== 'ticket') ||
      !payoutId ||
      awardUsers.has(userId) ||
      positions.has(position) ||
      payoutIds.has(payoutId) ||
      (deliveryKind === 'seat' && (!registrationId || candidate?.ticket_id !== null)) ||
      (deliveryKind === 'cash' &&
        (candidate?.registration_id !== null || candidate?.ticket_id !== null)) ||
      (deliveryKind === 'ticket' && (candidate?.registration_id !== null || !ticketId))
    ) {
      return null;
    }
    if (registrationId && registrationIds.has(registrationId)) return null;
    if (ticketId && ticketIds.has(ticketId)) return null;

    awardUsers.add(userId);
    positions.add(position);
    payoutIds.add(payoutId);
    if (registrationId) registrationIds.add(registrationId);
    if (ticketId) ticketIds.add(ticketId);
    if (deliveryKind === 'seat') observedSeats += 1;
    else if (deliveryKind === 'cash') observedCash += 1;
    else observedTickets += 1;

    const base = { userId, position, amount: amountCents / 100, payoutId };
    if (deliveryKind === 'seat' && registrationId) {
      awards.push({ ...base, deliveryKind, registrationId, ticketId: null });
    } else if (deliveryKind === 'cash') {
      awards.push({ ...base, deliveryKind, registrationId: null, ticketId: null });
    } else if (deliveryKind === 'ticket' && ticketId) {
      awards.push({ ...base, deliveryKind, registrationId: null, ticketId });
    } else {
      return null;
    }
  }
  awards.sort((a, b) => a.position - b.position);
  if (
    awards.some((award, index) => award.position !== index + 1) ||
    observedSeats !== seatCount ||
    observedCash !== cashTicketCount ||
    observedTickets !== entryTicketCount ||
    (ticketAwardCount > 0 && awards[0]?.userId !== winnerId)
  ) {
    return null;
  }

  const seats: VerifiedSatelliteSettlementReceipt['seats'] = [];
  for (const candidate of receipt.seats as SatelliteSettlementSeat[]) {
    const userId = uuid(candidate?.user_id);
    const position = positiveInteger(candidate?.position);
    const amountCents = exactCents(candidate?.amount);
    const registrationId = uuid(candidate?.registration_id);
    const award = awards.find((item) => item.position === position);
    if (
      !userId ||
      position === null ||
      amountCents !== ticketCents ||
      !registrationId ||
      award?.deliveryKind !== 'seat' ||
      award.userId !== userId ||
      award.registrationId !== registrationId
    ) {
      return null;
    }
    seats.push({ userId, position, amount: amountCents / 100, registrationId });
  }
  seats.sort((a, b) => a.position - b.position);
  if (
    seats.some(
      (seat, index) =>
        seat.position !== awards.filter((award) => award.deliveryKind === 'seat')[index]?.position
    )
  ) {
    return null;
  }

  const remainderCents = poolCents - ticketAwardCount * ticketCents;
  if (remainderCents < 0 || remainderCents >= ticketCents) return null;

  let remainder: VerifiedSatelliteSettlementReceipt['remainder'] = null;
  if (remainderCents === 0) {
    if (receipt.remainder !== null) return null;
  } else {
    const rawRemainder = receipt.remainder as SatelliteSettlementRemainder | null;
    const userId = uuid(rawRemainder?.user_id);
    const position = positiveInteger(rawRemainder?.position);
    const amountCents = exactCents(rawRemainder?.amount);
    if (
      !userId ||
      position !== ticketAwardCount + 1 ||
      position > fieldSize ||
      amountCents !== remainderCents ||
      awardUsers.has(userId) ||
      (ticketAwardCount === 0 && userId !== winnerId)
    ) {
      return null;
    }
    remainder = { userId, position, amount: remainderCents / 100 };
  }

  const expectedWinnerCents = ticketAwardCount > 0 ? ticketCents : remainderCents;
  if (winnerCents !== expectedWinnerCents) return null;

  return {
    receiptVersion: 2,
    tournamentId,
    targetId,
    winnerId,
    fieldSize,
    pool: poolCents / 100,
    ticketCost: ticketCents / 100,
    ticketAwardCount,
    seatCount,
    cashTicketCount,
    entryTicketCount,
    awards,
    seats,
    remainder,
    winnerAmount: winnerCents / 100,
    sourceCloseout: {
      sourceTableCount,
      sourceTableIds,
      sourceSeatCount,
      sourceSeatIds,
      releasedSeatCount,
      releasedSeatIds,
      closedAt,
    },
    settledAt,
  };
}
