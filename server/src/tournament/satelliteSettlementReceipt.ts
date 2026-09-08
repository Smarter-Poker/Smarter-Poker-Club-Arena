export type SatelliteTicketDeliveryKind = 'seat' | 'cash';

export interface SatelliteSettlementAward {
  user_id?: unknown;
  position?: unknown;
  amount?: unknown;
  delivery_kind?: unknown;
  payout_id?: unknown;
  registration_id?: unknown;
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
  awards: Array<{
    userId: string;
    position: number;
    amount: number;
    deliveryKind: SatelliteTicketDeliveryKind;
    payoutId: string;
    registrationId: string | null;
  }>;
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

function exactCents(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 1e-7 ? cents : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
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
 * full ticket is explicit as either an actual target seat or an exact cash
 * substitution.
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
  const poolCents = exactCents(receipt.pool);
  const ticketCents = exactCents(receipt.ticket_cost);
  const winnerCents = exactCents(receipt.winner_amount);
  const sourceTableCount = positiveInteger(receipt.source_table_count);
  const sourceSeatCount = nonNegativeInteger(receipt.source_seat_count);
  const releasedSeatCount = nonNegativeInteger(receipt.released_seat_count);
  const settledAt = typeof receipt.settled_at === 'string' ? receipt.settled_at : '';
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
  const closedAt = typeof rawCloseout?.closed_at === 'string' ? rawCloseout.closed_at : '';

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
    ticketAwardCount !== seatCount + cashTicketCount ||
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
    !closedAt ||
    closedAt !== settledAt ||
    !Number.isFinite(Date.parse(closedAt)) ||
    !settledAt ||
    !Number.isFinite(Date.parse(settledAt)) ||
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
  let observedSeats = 0;
  let observedCash = 0;

  for (const candidate of receipt.awards as SatelliteSettlementAward[]) {
    const userId = uuid(candidate?.user_id);
    const position = positiveInteger(candidate?.position);
    const amountCents = exactCents(candidate?.amount);
    const deliveryKind = candidate?.delivery_kind;
    const payoutId = uuid(candidate?.payout_id);
    const registrationId = uuid(candidate?.registration_id);
    if (
      !userId ||
      position === null ||
      position > ticketAwardCount ||
      amountCents !== ticketCents ||
      (deliveryKind !== 'seat' && deliveryKind !== 'cash') ||
      !payoutId ||
      awardUsers.has(userId) ||
      positions.has(position) ||
      payoutIds.has(payoutId) ||
      (deliveryKind === 'seat' && !registrationId) ||
      (deliveryKind === 'cash' && candidate?.registration_id != null)
    ) {
      return null;
    }
    if (registrationId && registrationIds.has(registrationId)) return null;

    awardUsers.add(userId);
    positions.add(position);
    payoutIds.add(payoutId);
    if (registrationId) registrationIds.add(registrationId);
    if (deliveryKind === 'seat') observedSeats += 1;
    else observedCash += 1;

    awards.push({
      userId,
      position,
      amount: amountCents / 100,
      deliveryKind,
      payoutId,
      registrationId,
    });
  }
  awards.sort((a, b) => a.position - b.position);
  if (
    awards.some((award, index) => award.position !== index + 1) ||
    observedSeats !== seatCount ||
    observedCash !== cashTicketCount ||
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
