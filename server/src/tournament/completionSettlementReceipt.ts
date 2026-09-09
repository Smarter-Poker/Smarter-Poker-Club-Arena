const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function exactMoney(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[0-9]+(?:[.][0-9]+)?$/.test(value)) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) < 1e-7 ? cents / 100 : null;
}

function exactCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^-?[0-9]+$/.test(value)) return null;
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

export interface VerifiedMysteryBountySettlementReceipt {
  poolCents: number;
  settledCents: number;
  unclaimedCents: number;
  residualPaidCents: number;
  varianceCents: number;
  reason: string | null;
}

export interface VerifiedBountyFinalizationReceipt {
  residual: number;
  funded: boolean;
  ledgerPaid: number | null;
  paidTo: string | null;
}

export interface VerifiedTournamentRakeReceipt {
  amount: number;
  destination: string;
  alreadySettled: boolean;
  settledAt: string | null;
  attributed: boolean | null;
  attributedUsers: number | null;
}

export type TournamentTerminalSettlementMode = 'places' | 'final_table_deal';

export interface VerifiedTournamentCompletionReceipt {
  tournamentId: string;
  winnerId: string;
  settlementMode: TournamentTerminalSettlementMode;
  payouts: Array<{ userId: string; place: number; amount: number }>;
  dealShares: Array<{ userId: string; place: number; amount: number }>;
  winnerAmount: number;
  bubbleProtection: { userId: string; position: number; amount: number } | null;
  cashPayoutTotal: number;
  bountyPayoutTotal: number;
  tableClosure: {
    closedTableCount: number;
    closedTableIds: string[];
    sourceSeatCount: number;
    sourceSeatIds: string[];
    releasedSeatCount: number;
    releasedSeatIds: string[];
  };
  rake: {
    amount: number;
    destination: string;
    attributedUsers: number;
    settledAt: string;
    attributedAt: string;
  };
  settledAt: string;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

type VerifiedPayoutLine = { userId: string; place: number; amount: number };

function payoutLines(value: unknown): VerifiedPayoutLine[] | null {
  if (!Array.isArray(value)) return null;
  const payouts: VerifiedPayoutLine[] = [];
  const users = new Set<string>();
  const places = new Set<number>();
  let priorPlace = 0;
  for (const candidate of value) {
    const payout = parseObject(candidate);
    const userId = uuid(payout.user_id);
    const place = nonNegativeInteger(payout.place);
    const amount = exactMoney(payout.amount);
    if (
      userId === null ||
      place === null ||
      place < 1 ||
      place <= priorPlace ||
      amount === null ||
      users.has(userId) ||
      places.has(place)
    ) {
      return null;
    }
    users.add(userId);
    places.add(place);
    priorPlace = place;
    payouts.push({ userId, place, amount });
  }
  return payouts;
}

function samePayoutLines(left: VerifiedPayoutLine[], right: VerifiedPayoutLine[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (line, index) =>
        line.userId === right[index].userId &&
        line.place === right[index].place &&
        line.amount === right[index].amount
    )
  );
}

function canonicalUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const candidate of value) {
    const id = uuid(candidate);
    if (id === null || (ids.length > 0 && ids[ids.length - 1] >= id)) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * Validate the one immutable receipt returned by the non-satellite terminal
 * authority. The game server treats every field as evidence: malformed JSON,
 * a partial payout list, an unattributed rake row, or a nonzero escrow balance
 * all leave presentation cleanup unacknowledged even if the transport call
 * itself succeeded.
 */
export function verifyTournamentCompletionReceipt(
  raw: unknown,
  expectedTournamentId: string,
  expectedMode: TournamentTerminalSettlementMode,
  expectedWinnerId?: string | null
): VerifiedTournamentCompletionReceipt | null {
  const receipt = parseObject(raw);
  const tournamentId = uuid(receipt.tournament_id);
  const winnerId = uuid(receipt.winner_id);
  const winnerAmount = exactMoney(receipt.winner_amount);
  const cashPayoutTotal = exactMoney(receipt.cash_payout_total);
  const bountyPayoutTotal = exactMoney(receipt.bounty_payout_total);
  const settledAt = validTimestamp(receipt.settled_at);
  const escrow = parseObject(receipt.escrow);
  const prizeBalance = exactMoney(escrow.prize_balance);
  const bountyBalance = exactMoney(escrow.bounty_balance);
  const feeBalance = exactMoney(escrow.fee_balance);

  if (
    receipt.ok !== true ||
    receipt.fully_settled !== true ||
    receipt.status !== 'COMPLETED' ||
    Number(receipt.receipt_version) !== 1 ||
    tournamentId !== expectedTournamentId ||
    winnerId === null ||
    (expectedWinnerId != null && winnerId !== expectedWinnerId) ||
    receipt.mode !== expectedMode ||
    receipt.settlement_mode !== expectedMode ||
    winnerAmount === null ||
    cashPayoutTotal === null ||
    bountyPayoutTotal === null ||
    settledAt === null ||
    prizeBalance !== 0 ||
    bountyBalance !== 0 ||
    feeBalance !== 0
  ) {
    return null;
  }

  const payouts = payoutLines(receipt.payouts);
  const dealShares = payoutLines(receipt.deal_shares);
  if (
    payouts === null ||
    dealShares === null ||
    payouts.length < 1 ||
    (expectedMode === 'places' && dealShares.length !== 0) ||
    (expectedMode === 'final_table_deal' && dealShares.length < 1) ||
    dealShares.some(
      (share) =>
        !payouts.some(
          (payout) =>
            payout.userId === share.userId &&
            payout.place === share.place &&
            payout.amount === share.amount
        )
    )
  ) {
    return null;
  }
  let payoutCents = 0;
  for (const payout of payouts) {
    payoutCents += Math.round(payout.amount * 100);
    if (!Number.isSafeInteger(payoutCents)) return null;
  }
  if (
    payouts.length < 1 ||
    !payouts.some(
      (payout) => payout.place === 1 && payout.userId === winnerId && payout.amount === winnerAmount
    )
  ) {
    return null;
  }

  let bubbleProtection: VerifiedTournamentCompletionReceipt['bubbleProtection'] = null;
  if (receipt.bubble_protection != null) {
    const bubble = parseObject(receipt.bubble_protection);
    const userId = uuid(bubble.user_id);
    const position = nonNegativeInteger(bubble.position);
    const amount = exactMoney(bubble.amount);
    if (userId === null || position === null || position < 2 || amount === null || amount <= 0) {
      return null;
    }
    payoutCents += Math.round(amount * 100);
    if (!Number.isSafeInteger(payoutCents)) return null;
    bubbleProtection = { userId, position, amount };
  }
  if (payoutCents !== Math.round(cashPayoutTotal * 100)) return null;

  const cash = parseObject(receipt.cash);
  const cashPayouts = payoutLines(cash.payouts);
  const cashDealShares = payoutLines(cash.deal_shares);
  if (
    cash.ok !== true ||
    cash.fully_settled !== true ||
    cash.status !== 'COMPLETING' ||
    exactMoney(cash.winner_amount) !== winnerAmount ||
    cashPayouts === null ||
    cashDealShares === null ||
    !samePayoutLines(cashPayouts, payouts) ||
    !samePayoutLines(cashDealShares, dealShares)
  ) {
    return null;
  }

  const cashBubble = cash.bubble_protection;
  if (bubbleProtection === null) {
    if (cashBubble != null) return null;
  } else {
    const nestedBubble = parseObject(cashBubble);
    if (
      uuid(nestedBubble.user_id) !== bubbleProtection.userId ||
      nonNegativeInteger(nestedBubble.position) !== bubbleProtection.position ||
      exactMoney(nestedBubble.amount) !== bubbleProtection.amount
    ) {
      return null;
    }
  }

  const tableClosure = parseObject(receipt.table_closure);
  const closedTableCount = nonNegativeInteger(receipt.closed_table_count);
  const sourceSeatCount = nonNegativeInteger(receipt.source_seat_count);
  const releasedSeatCount = nonNegativeInteger(receipt.released_seat_count);
  const nestedClosedTableCount = nonNegativeInteger(tableClosure.closed_table_count);
  const nestedSourceSeatCount = nonNegativeInteger(tableClosure.source_seat_count);
  const nestedReleasedSeatCount = nonNegativeInteger(tableClosure.released_seat_count);
  const closedTableIds = canonicalUuidArray(tableClosure.closed_table_ids);
  const sourceSeatIds = canonicalUuidArray(tableClosure.source_seat_ids);
  const releasedSeatIds = canonicalUuidArray(tableClosure.released_seat_ids);
  if (
    closedTableCount === null ||
    sourceSeatCount === null ||
    releasedSeatCount === null ||
    nestedClosedTableCount !== closedTableCount ||
    nestedSourceSeatCount !== sourceSeatCount ||
    nestedReleasedSeatCount !== releasedSeatCount ||
    closedTableIds === null ||
    sourceSeatIds === null ||
    releasedSeatIds === null ||
    closedTableIds.length !== closedTableCount ||
    sourceSeatIds.length !== sourceSeatCount ||
    releasedSeatIds.length !== releasedSeatCount ||
    releasedSeatIds.some((id) => !sourceSeatIds.includes(id))
  ) {
    return null;
  }

  const mystery = verifyMysteryBountySettlementReceipt(receipt.mystery_bounty);
  if (
    mystery === null ||
    mystery.settledCents !== mystery.poolCents ||
    mystery.varianceCents !== 0 ||
    mystery.poolCents > Math.round(bountyPayoutTotal * 100)
  ) {
    return null;
  }

  const rawBounty = parseObject(receipt.bounty);
  if (bountyPayoutTotal === 0) {
    if (
      rawBounty.ok !== true ||
      rawBounty.funded !== true ||
      exactMoney(rawBounty.residual) !== 0 ||
      rawBounty.reason !== 'not_a_bounty_tournament'
    ) {
      return null;
    }
  } else {
    const bounty = verifyBountyFinalizationReceipt(receipt.bounty, winnerId);
    if (
      bounty === null ||
      bounty.funded !== true ||
      bounty.ledgerPaid === null ||
      Math.round((bounty.ledgerPaid + bounty.residual) * 100) !==
        Math.round(bountyPayoutTotal * 100)
    ) {
      return null;
    }
  }

  const rake = parseObject(receipt.rake);
  const rakeAmount = exactMoney(rake.amount);
  const rakeDestination =
    typeof rake.destination === 'string' && rake.destination.length > 0 ? rake.destination : null;
  const attributedUsers = nonNegativeInteger(rake.attributed_users);
  const rakeSettledAt = validTimestamp(rake.settled_at);
  const rakeAttributedAt = validTimestamp(rake.attributed_at);
  if (
    rakeAmount === null ||
    rakeDestination === null ||
    rakeDestination === 'pending' ||
    rake.attributed !== true ||
    attributedUsers === null ||
    rakeSettledAt === null ||
    rakeAttributedAt === null ||
    Date.parse(rakeSettledAt) > Date.parse(settledAt) ||
    Date.parse(rakeAttributedAt) > Date.parse(settledAt)
  ) {
    return null;
  }

  return {
    tournamentId,
    winnerId,
    settlementMode: expectedMode,
    payouts,
    dealShares,
    winnerAmount,
    bubbleProtection,
    cashPayoutTotal,
    bountyPayoutTotal,
    tableClosure: {
      closedTableCount,
      closedTableIds,
      sourceSeatCount,
      sourceSeatIds,
      releasedSeatCount,
      releasedSeatIds,
    },
    rake: {
      amount: rakeAmount,
      destination: rakeDestination,
      attributedUsers,
      settledAt: rakeSettledAt,
      attributedAt: rakeAttributedAt,
    },
    settledAt,
  };
}

/**
 * The database receipt is evidence, not a status blob. A mystery bounty
 * settlement is only good enough to complete on when the pool, paid total and
 * residual are all exact and the function says the pool balanced.
 */
export function verifyMysteryBountySettlementReceipt(
  raw: unknown
): VerifiedMysteryBountySettlementReceipt | null {
  const receipt = parseObject(raw);
  const poolCents = exactCents(receipt.pool_cents);
  const settledCents = exactCents(receipt.settled_cents);
  const unclaimedCents = exactCents(receipt.unclaimed_cents);
  const residualPaidCents = exactCents(receipt.residual_paid_cents);
  const varianceCents = exactCents(receipt.variance_cents);

  if (
    receipt.ok !== true ||
    receipt.balanced !== true ||
    poolCents === null ||
    settledCents === null ||
    unclaimedCents === null ||
    residualPaidCents === null ||
    varianceCents === null ||
    varianceCents !== 0 ||
    settledCents !== poolCents ||
    residualPaidCents > poolCents ||
    (typeof receipt.reason !== 'undefined' &&
      receipt.reason !== null &&
      typeof receipt.reason !== 'string')
  ) {
    return null;
  }

  return {
    poolCents,
    settledCents,
    unclaimedCents,
    residualPaidCents,
    varianceCents,
    reason: typeof receipt.reason === 'string' ? receipt.reason : null,
  };
}

/**
 * A bounty finalization receipt proves the remaining pool reached the champion
 * or that there was nothing left to pay, and that the shape came back intact.
 */
export function verifyBountyFinalizationReceipt(
  raw: unknown,
  expectedWinnerId: string
): VerifiedBountyFinalizationReceipt | null {
  const receipt = parseObject(raw);
  const residual = exactMoney(receipt.residual);
  const funded = typeof receipt.funded === 'boolean' ? receipt.funded : undefined;
  const ledgerPaid =
    typeof receipt.ledger_paid === 'undefined' ? null : exactMoney(receipt.ledger_paid);
  const paidTo = typeof receipt.paid_to === 'undefined' ? null : uuid(receipt.paid_to);

  if (
    receipt.ok !== true ||
    residual === null ||
    funded === undefined ||
    (typeof receipt.ledger_paid !== 'undefined' && ledgerPaid === null) ||
    (residual > 0 && paidTo !== expectedWinnerId) ||
    (residual === 0 && paidTo !== null) ||
    (funded === true && ledgerPaid === null) ||
    (funded === false && ledgerPaid !== null)
  ) {
    return null;
  }

  return {
    residual,
    funded,
    ledgerPaid,
    paidTo,
  };
}

/**
 * A rake receipt is only good enough to close the event when the settlement
 * reported success and returned a real amount/destination pair.
 */
export function verifyTournamentRakeReceipt(raw: unknown): VerifiedTournamentRakeReceipt | null {
  const receipt = parseObject(raw);
  const amount = exactMoney(receipt.amount);
  const destination =
    typeof receipt.destination === 'string' && receipt.destination.length > 0
      ? receipt.destination
      : null;
  const alreadySettled =
    typeof receipt.already_settled === 'undefined'
      ? false
      : typeof receipt.already_settled === 'boolean'
        ? receipt.already_settled
        : undefined;
  const hasAttributed = typeof receipt.attributed !== 'undefined';
  const attributed = !hasAttributed
    ? null
    : typeof receipt.attributed === 'boolean'
      ? receipt.attributed
      : undefined;
  const hasAttributedUsers = typeof receipt.attributed_users !== 'undefined';
  const attributedUsers = !hasAttributedUsers
    ? null
    : Number.isSafeInteger(Number(receipt.attributed_users)) &&
        Number(receipt.attributed_users) >= 0
      ? Number(receipt.attributed_users)
      : undefined;
  const hasSettledAt = typeof receipt.settled_at !== 'undefined';
  const settledAt = !hasSettledAt
    ? null
    : typeof receipt.settled_at === 'string' && Number.isFinite(Date.parse(receipt.settled_at))
      ? receipt.settled_at
      : undefined;
  const noRakeDestination = destination === 'none' || destination === 'no_club';

  if (
    receipt.ok !== true ||
    amount === null ||
    destination === null ||
    destination === 'pending' ||
    alreadySettled === undefined ||
    (hasAttributed && attributed === undefined) ||
    (hasAttributedUsers && attributedUsers === undefined) ||
    (hasSettledAt && settledAt === undefined) ||
    (alreadySettled && settledAt === null)
  ) {
    return null;
  }

  if (!alreadySettled && !noRakeDestination && (attributed !== true || attributedUsers === null)) {
    return null;
  }

  return {
    amount,
    destination,
    alreadySettled,
    settledAt: settledAt ?? null,
    attributed: attributed ?? null,
    attributedUsers: attributedUsers ?? null,
  };
}
