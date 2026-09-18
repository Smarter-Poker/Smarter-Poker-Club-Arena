import { UUID_SHAPE as UUID } from '../lib/uuidShape.js';

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
    settledAt: string | null;
    attributedAt: string | null;
    accountingState: string;
    accountingReason: string | null;
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
  const custodyVersion = receipt.receipt_version === 3;
  const custody = parseObject(parseObject(receipt.rake).accounting);
  const cohort: Record<string, { amount: number; fingerprint: string; count: number }> = {
    '2d2319d4-09e4-4921-85f3-09832ca7f9da': {
      amount: 54,
      fingerprint: '94462de304de8ab16ff492cadf13d229',
      count: 54,
    },
    '7834a033-8bf0-4a6b-bccf-9f4f6e78a9b9': {
      amount: 120,
      fingerprint: '57840c57d89643def8db903c4b19b487',
      count: 80,
    },
    '80443725-b71c-4fc6-bc09-ceaf650809b3': {
      amount: 54,
      fingerprint: 'bae6c0de665f87d378bda4249963b51b',
      count: 54,
    },
    'b1fdf860-2fdd-40da-8fff-ef37e650ddc8': {
      amount: 120,
      fingerprint: '70dd50a8c0fc28b2ff5d4b53de2f56d1',
      count: 80,
    },
    'f370585d-40ea-4085-bb8f-c7e8c74f3fb4': {
      amount: 17,
      fingerprint: 'f67bf12ee0b00c954b6f8403de9718fe',
      count: 34,
    },
    '1ffbd637-9241-4957-902f-3a75e09892c0': {
      amount: 127.5,
      fingerprint: '53fd19518004de9991312c0aaa749705',
      count: 85,
    },
    '8fc76450-534a-4877-97b5-8f784a3d5daa': {
      amount: 127.5,
      fingerprint: '87fd65baf92f74a1de5c85ed09844c62',
      count: 85,
    },
    '2421c66f-6f02-40a2-8414-23379802ce23': {
      amount: 69,
      fingerprint: '0dd99b682fed61573e47a2e0f8e57ab8',
      count: 46,
    },
  };
  const original = tournamentId === null ? undefined : cohort[tournamentId];
  const resolution = parseObject(custody.resolution);
  const resolutionBank = uuid(resolution.bank_receipt_id);
  const resolutionClub = uuid(resolution.bank_club_id);
  const resolutionUnion = uuid(resolution.bank_union_id);
  const resolutionAt = validTimestamp(resolution.banked_at);
  const custodyResolved = custodyVersion && custody.accounting_complete === true;
  const exactCustodyResolution =
    custodyResolved &&
    receipt.fully_settled === true &&
    receipt.accounting_complete === true &&
    receipt.accounting_state === 'recognized' &&
    custody.current_held_amount === 0 &&
    feeBalance === 0 &&
    resolution.accounting_version === 2 &&
    resolution.status === 'recognized' &&
    resolution.payable === true &&
    uuid(resolution.tournament_id) === tournamentId &&
    resolution.source_fingerprint === original?.fingerprint &&
    exactMoney(resolution.bank_amount) === original?.amount &&
    nonNegativeInteger(resolution.recognized_source_count) === original?.count &&
    resolutionAt !== null &&
    settledAt !== null &&
    Date.parse(resolutionAt) >= Date.parse(settledAt) &&
    resolutionBank !== null &&
    resolutionClub !== null &&
    (resolution.bank_receipt_kind === 'union_wallet_transaction'
      ? resolutionUnion !== null
      : resolution.bank_receipt_kind === 'chip_ledger' && resolution.bank_union_id === null);
  const exactCustody =
    custodyVersion &&
    original !== undefined &&
    receipt.player_result === 'final' &&
    custody.accounting_version === 3 &&
    custody.status === 'fee_custody_unresolved' &&
    custody.player_result === 'final' &&
    custody.payable === false &&
    custody.custody_store === 'tournament_escrow' &&
    uuid(custody.tournament_id) === tournamentId &&
    uuid(custody.obligation_id) !== null &&
    custody.source_fingerprint === original.fingerprint &&
    custody.source_count === original.count &&
    exactMoney(custody.held_amount) === original.amount &&
    validTimestamp(custody.held_at) !== null &&
    settledAt !== null &&
    Date.parse(String(custody.held_at)) <= Date.parse(settledAt) &&
    custody.recognized_source_count === 0 &&
    custody.bank_amount === 0 &&
    custody.banked_at === null &&
    custody.bank_receipt_id === null &&
    escrow.closed_at === null &&
    escrow.close_note === null &&
    (custodyResolved
      ? exactCustodyResolution
      : receipt.fully_settled === false &&
        receipt.accounting_complete === false &&
        receipt.accounting_state === 'fee_custody_unresolved' &&
        custody.accounting_complete === false &&
        custody.resolution === null &&
        exactMoney(custody.current_held_amount) === original.amount &&
        feeBalance === original.amount);

  if (
    receipt.ok !== true ||
    (!custodyVersion && receipt.fully_settled !== true) ||
    (custodyVersion && !exactCustody) ||
    receipt.status !== 'COMPLETED' ||
    ![1, 2, 3].includes(Number(receipt.receipt_version)) ||
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
    (!custodyVersion && feeBalance !== 0)
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
  const receiptVersion = Number(receipt.receipt_version);
  const accounting = parseObject(rake.accounting);
  const accountingState = receiptVersion === 1 ? 'legacy' : accounting.status;
  const isDeferred = accountingState === 'banked_accrual_deferred';
  const bankAmount = exactMoney(accounting.bank_amount);
  const bankedAt = validTimestamp(accounting.banked_at);
  const bankId = uuid(accounting.bank_receipt_id);
  const bankClub = uuid(accounting.bank_club_id);
  const bankUnion = uuid(accounting.bank_union_id);
  const sourceCount = nonNegativeInteger(accounting.recognized_source_count);
  const deferredReasons = [
    'tournament_fee_sources_require_reconciliation',
    'accounting_terms_not_observed',
    'accounting_terms_not_active',
    'tournament_fee_not_captured_by_original_producer',
  ];
  const exactBank =
    bankAmount === 0
      ? accounting.bank_receipt_kind === 'none' &&
        accounting.bank_receipt_id === null &&
        rakeDestination === 'none'
      : bankId !== null &&
        bankClub !== null &&
        (accounting.bank_receipt_kind === 'union_wallet_transaction'
          ? bankUnion !== null && rakeDestination === `union:${bankUnion}`
          : accounting.bank_receipt_kind === 'chip_ledger' &&
            accounting.bank_union_id === null &&
            rakeDestination === `chip_retirement:${bankClub}`);
  const exactAccounting =
    (exactCustody &&
      rakeAmount === original?.amount &&
      rakeDestination === 'tournament_escrow' &&
      rake.attributed === false &&
      rake.attributed_users === 0 &&
      rake.settled_at === null &&
      rake.attributed_at === null &&
      typeof accounting.reason === 'string' &&
      deferredReasons.includes(accounting.reason)) ||
    receiptVersion === 1 ||
    (receiptVersion === 2 &&
      accounting.accounting_version === 2 &&
      uuid(accounting.tournament_id) === tournamentId &&
      bankAmount !== null &&
      bankAmount === rakeAmount &&
      bankedAt !== null &&
      bankedAt === rakeSettledAt &&
      exactBank &&
      typeof accounting.source_fingerprint === 'string' &&
      /^[0-9a-f]{32}$/.test(accounting.source_fingerprint) &&
      sourceCount !== null &&
      (isDeferred
        ? accounting.payable === false &&
          sourceCount === 0 &&
          attributedUsers === 0 &&
          rake.attributed === false &&
          rake.attributed_at === null &&
          typeof accounting.reason === 'string' &&
          deferredReasons.includes(accounting.reason)
        : (accountingState === 'recognized' &&
            accounting.payable === true &&
            bankAmount > 0 &&
            sourceCount > 0) ||
          (accountingState === 'cancelled' && accounting.payable === false && bankAmount === 0)));
  if (
    rakeAmount === null ||
    rakeDestination === null ||
    rakeDestination === 'pending' ||
    !exactAccounting ||
    (!isDeferred && !custodyVersion && rake.attributed !== true) ||
    attributedUsers === null ||
    (!custodyVersion && rakeSettledAt === null) ||
    (!isDeferred && !custodyVersion && rakeAttributedAt === null) ||
    (rakeSettledAt !== null && Date.parse(rakeSettledAt) > Date.parse(settledAt)) ||
    (rakeAttributedAt !== null && Date.parse(rakeAttributedAt) > Date.parse(settledAt))
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
      accountingState: custodyResolved ? 'recognized' : String(accountingState),
      accountingReason:
        isDeferred || (custodyVersion && !custodyResolved) ? String(accounting.reason) : null,
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
