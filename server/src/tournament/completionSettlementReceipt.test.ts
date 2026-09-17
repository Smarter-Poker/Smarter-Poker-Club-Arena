import { describe, expect, it } from 'vitest';
import { verifyTournamentCompletionReceipt } from './completionSettlementReceipt.js';

const TOURNAMENT_ID = '11111111-2222-4333-8444-555555555555';
const WINNER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUNNER_ID = '11111111-aaaa-4bbb-8ccc-222222222222';
const BUBBLE_ID = '33333333-aaaa-4bbb-8ccc-444444444444';
const TABLE_ID = '44444444-aaaa-4bbb-8ccc-555555555555';
const SEAT_A_ID = '55555555-aaaa-4bbb-8ccc-666666666666';
const SEAT_B_ID = '66666666-aaaa-4bbb-8ccc-777777777777';

function receipt(): any {
  const payouts = [
    { user_id: WINNER_ID, place: 1, amount: 70 },
    { user_id: RUNNER_ID, place: 2, amount: 20 },
  ];
  return {
    ok: true,
    fully_settled: true,
    status: 'COMPLETED',
    tournament_id: TOURNAMENT_ID,
    winner_id: WINNER_ID,
    mode: 'places',
    settlement_mode: 'places',
    payouts,
    deal_shares: [],
    winner_amount: 70,
    bubble_protection: { user_id: BUBBLE_ID, position: 3, amount: 10 },
    cash: {
      ok: true,
      fully_settled: true,
      status: 'COMPLETING',
      payouts,
      deal_shares: [],
      winner_amount: 70,
      bubble_protection: { user_id: BUBBLE_ID, position: 3, amount: 10 },
    },
    mystery_bounty: {
      ok: true,
      reason: 'not_a_mystery_tournament',
      pool_cents: 0,
      settled_cents: 0,
      unclaimed_cents: 0,
      residual_paid_cents: 0,
      balanced: true,
      variance_cents: 0,
    },
    bounty: {
      ok: true,
      funded: true,
      residual: 0,
      reason: 'not_a_bounty_tournament',
    },
    closed_table_count: 1,
    source_seat_count: 2,
    released_seat_count: 2,
    table_closure: {
      closed_table_count: 1,
      closed_table_ids: [TABLE_ID],
      source_seat_count: 2,
      source_seat_ids: [SEAT_A_ID, SEAT_B_ID],
      released_seat_count: 2,
      released_seat_ids: [SEAT_A_ID, SEAT_B_ID],
    },
    rake: {
      amount: 3,
      destination: 'club_treasury:55555555-aaaa-4bbb-8ccc-666666666666',
      attributed: true,
      attributed_users: 2,
      settled_at: '2026-09-08T05:00:00.000Z',
      attributed_at: '2026-09-08T05:00:00.000Z',
    },
    escrow: { prize_balance: 0, bounty_balance: 0, fee_balance: 0 },
    cash_payout_total: 100,
    bounty_payout_total: 0,
    receipt_version: 1,
    settled_at: '2026-09-08T05:00:00.000Z',
  };
}

describe('verifyTournamentCompletionReceipt', () => {
  it('accepts one exact stored terminal receipt and normalizes its presentation fields', () => {
    const verified = verifyTournamentCompletionReceipt(
      JSON.stringify(receipt()),
      TOURNAMENT_ID,
      'places',
      WINNER_ID
    );
    expect(verified).toMatchObject({
      tournamentId: TOURNAMENT_ID,
      winnerId: WINNER_ID,
      settlementMode: 'places',
      winnerAmount: 70,
      cashPayoutTotal: 100,
      bountyPayoutTotal: 0,
    });
    expect(verified?.payouts).toEqual([
      { userId: WINNER_ID, place: 1, amount: 70 },
      { userId: RUNNER_ID, place: 2, amount: 20 },
    ]);
    expect(verified?.dealShares).toEqual([]);
    expect(verified?.tableClosure).toEqual({
      closedTableCount: 1,
      closedTableIds: [TABLE_ID],
      sourceSeatCount: 2,
      sourceSeatIds: [SEAT_A_ID, SEAT_B_ID],
      releasedSeatCount: 2,
      releasedSeatIds: [SEAT_A_ID, SEAT_B_ID],
    });
    expect(verified?.bubbleProtection).toEqual({
      userId: BUBBLE_ID,
      position: 3,
      amount: 10,
    });
  });

  it.each([
    ['partial result', (value: any) => (value.fully_settled = false)],
    ['wrong terminal status', (value: any) => (value.status = 'COMPLETING')],
    ['wrong mode alias', (value: any) => (value.mode = 'final_table_deal')],
    ['wrong winner', (value: any) => (value.winner_id = RUNNER_ID)],
    ['duplicate place', (value: any) => (value.payouts[1].place = 1)],
    ['cash evidence mismatch', (value: any) => (value.cash.payouts[1].amount = 19)],
    ['unexpected places deal shares', (value: any) => value.deal_shares.push(value.payouts[0])],
    ['cash winner mismatch', (value: any) => (value.cash.winner_amount = 69)],
    ['cash bubble mismatch', (value: any) => (value.cash.bubble_protection.amount = 9)],
    ['cash total mismatch', (value: any) => (value.cash_payout_total = 99.99)],
    ['missing mystery proof', (value: any) => (value.mystery_bounty = null)],
    ['unbalanced mystery proof', (value: any) => (value.mystery_bounty.balanced = false)],
    ['missing bounty proof', (value: any) => (value.bounty = null)],
    ['nonzero prize escrow', (value: any) => (value.escrow.prize_balance = 0.01)],
    ['unattributed rake', (value: any) => (value.rake.attributed = false)],
    ['pending rake destination', (value: any) => (value.rake.destination = 'pending')],
    ['missing attribution timestamp', (value: any) => (value.rake.attributed_at = null)],
    ['missing closure proof', (value: any) => (value.table_closure = null)],
    ['closure count mismatch', (value: any) => (value.closed_table_count = 2)],
    ['source seat count mismatch', (value: any) => (value.source_seat_count = 1)],
    [
      'source seat identity mismatch',
      (value: any) => (value.table_closure.source_seat_ids[1] = TABLE_ID),
    ],
    [
      'released seat identity mismatch',
      (value: any) => (value.table_closure.released_seat_ids[1] = TABLE_ID),
    ],
    [
      'noncanonical closure identities',
      (value: any) => value.table_closure.released_seat_ids.reverse(),
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = receipt();
    mutate(value);
    expect(verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)).toBeNull();
  });

  it('rejects a malformed transport payload', () => {
    expect(
      verifyTournamentCompletionReceipt('{not-json', TOURNAMENT_ID, 'places', WINNER_ID)
    ).toBeNull();
  });

  it('separates live deal shares from the complete historic payout ledger', () => {
    const value = receipt();
    const eliminatedId = '22222222-aaaa-4bbb-8ccc-333333333333';
    value.mode = 'final_table_deal';
    value.settlement_mode = 'final_table_deal';
    value.payouts = [
      { user_id: WINNER_ID, place: 1, amount: 45 },
      { user_id: RUNNER_ID, place: 2, amount: 25 },
      { user_id: eliminatedId, place: 3, amount: 20 },
    ];
    value.deal_shares = value.payouts.slice(0, 2);
    value.winner_amount = 45;
    value.cash.payouts = value.payouts;
    value.cash.deal_shares = value.deal_shares;
    value.cash.winner_amount = 45;

    const verified = verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'final_table_deal');
    expect(verified?.payouts).toHaveLength(3);
    expect(verified?.dealShares).toEqual([
      { userId: WINNER_ID, place: 1, amount: 45 },
      { userId: RUNNER_ID, place: 2, amount: 25 },
    ]);
  });

  it('accepts a zero-cash winner line without inventing a payment', () => {
    const value = receipt();
    value.payouts = [{ user_id: WINNER_ID, place: 1, amount: 0 }];
    value.winner_amount = 0;
    value.bubble_protection = null;
    value.cash.payouts = value.payouts;
    value.cash.winner_amount = 0;
    value.cash.bubble_protection = null;
    value.cash_payout_total = 0;

    expect(
      verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)
    ).not.toBeNull();
  });
});

function deferredReceipt(): any {
  const value = receipt();
  value.receipt_version = 2;
  value.rake.destination = `chip_retirement:${SEAT_A_ID}`;
  value.rake.attributed = false;
  value.rake.attributed_users = 0;
  value.rake.attributed_at = null;
  value.rake.accounting = {
    accounting_version: 2,
    tournament_id: TOURNAMENT_ID,
    status: 'banked_accrual_deferred',
    reason: 'tournament_fee_sources_require_reconciliation',
    bank_amount: 3,
    banked_at: value.rake.settled_at,
    bank_club_id: SEAT_A_ID,
    bank_union_id: null,
    bank_receipt_kind: 'chip_ledger',
    bank_receipt_id: TABLE_ID,
    source_fingerprint: 'a'.repeat(32),
    payable: false,
    recognized_source_count: 0,
  };
  return value;
}
describe('version 2 separates paid prizes from deferred rake accounting', () => {
  it('accepts completed custody with an exact deferred bank receipt and reports the deferral', () => {
    const result = verifyTournamentCompletionReceipt(
      deferredReceipt(),
      TOURNAMENT_ID,
      'places',
      WINNER_ID
    );
    expect(result?.rake).toMatchObject({
      attributedAt: null,
      attributedUsers: 0,
      accountingState: 'banked_accrual_deferred',
      accountingReason: 'tournament_fee_sources_require_reconciliation',
    });
  });
  it.each([
    ['bank amount differs', (r: any) => (r.rake.accounting.bank_amount = 2.99)],
    [
      'bank timestamp differs',
      (r: any) => (r.rake.accounting.banked_at = '2026-09-08T05:00:01.000Z'),
    ],
    ['bank identity missing', (r: any) => (r.rake.accounting.bank_receipt_id = null)],
    ['wrong bank destination', (r: any) => (r.rake.accounting.bank_club_id = TABLE_ID)],
    [
      'treasury destination impersonates private retirement',
      (r: any) => (r.rake.destination = `club_treasury:${SEAT_A_ID}`),
    ],
    ['wrong event', (r: any) => (r.rake.accounting.tournament_id = WINNER_ID)],
    ['unknown accounting version', (r: any) => (r.rake.accounting.accounting_version = 1)],
    ['pretends payable', (r: any) => (r.rake.accounting.payable = true)],
    ['partial source recognition', (r: any) => (r.rake.accounting.recognized_source_count = 1)],
    ['false attribution stamp', (r: any) => (r.rake.attributed_at = r.rake.settled_at)],
    ['false attributed users', (r: any) => (r.rake.attributed_users = 1)],
    ['unknown deferral reason', (r: any) => (r.rake.accounting.reason = 'ignore me')],
    ['missing source fingerprint', (r: any) => (r.rake.accounting.source_fingerprint = null)],
    ['legacy version with deferred payload', (r: any) => (r.receipt_version = 1)],
    ['unpaid prize disguised by accounting', (r: any) => (r.cash_payout_total = 99)],
    ['money remains in custody', (r: any) => (r.escrow.fee_balance = 3)],
  ])('refuses %s', (_name, mutate) => {
    const value = deferredReceipt();
    mutate(value);
    expect(verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)).toBeNull();
  });
  it('requires exact bank proof even for newly recognized version2 receipts', () => {
    const value = deferredReceipt();
    value.rake.attributed = true;
    value.rake.attributed_at = value.rake.settled_at;
    value.rake.attributed_users = 2;
    value.rake.accounting.status = 'recognized';
    value.rake.accounting.payable = true;
    value.rake.accounting.recognized_source_count = 2;
    value.rake.accounting.reason = null;
    expect(
      verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)?.rake
        .accountingState
    ).toBe('recognized');
    value.rake.accounting.bank_receipt_id = null;
    expect(verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)).toBeNull();
  });
  it('preserves exact union bank receipts', () => {
    const value = deferredReceipt();
    value.rake.destination = `union:${SEAT_B_ID}`;
    value.rake.accounting.bank_union_id = SEAT_B_ID;
    value.rake.accounting.bank_receipt_kind = 'union_wallet_transaction';
    expect(
      verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)
    ).not.toBeNull();
    value.rake.destination = `chip_retirement:${SEAT_A_ID}`;
    expect(verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)).toBeNull();
  });
  it('preserves zero-fee completion without inventing a bank movement', () => {
    const value = deferredReceipt();
    Object.assign(value.rake, {
      amount: 0,
      destination: 'none',
      attributed: true,
      attributed_at: value.rake.settled_at,
    });
    Object.assign(value.rake.accounting, {
      status: 'cancelled',
      reason: null,
      bank_amount: 0,
      bank_receipt_kind: 'none',
      bank_receipt_id: null,
    });
    expect(
      verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)
    ).not.toBeNull();
    value.rake.accounting.bank_receipt_id = TABLE_ID;
    expect(verifyTournamentCompletionReceipt(value, TOURNAMENT_ID, 'places', WINNER_ID)).toBeNull();
  });
});

import {
  accountingTerminalReceipts,
  fullLifecycleTerminalReceipts,
} from './__fixtures__/accountingTerminalReceipts.js';
describe('actual native terminal fee receipts', () => {
  it.each(accountingTerminalReceipts)(
    'accepts the actual $rake.accounting.status custody receipt',
    (nativeReceipt) => {
      const verified = verifyTournamentCompletionReceipt(
        nativeReceipt,
        nativeReceipt.tournament_id,
        'places',
        nativeReceipt.winner_id
      );
      expect(verified).not.toBeNull();
      expect(verified?.rake.accountingState).toBe(nativeReceipt.rake.accounting.status);
    }
  );
});

describe('historical nonzero full lifecycle captures', () => {
  // Keep the captured predecessor bytes unchanged. Their v2 private treasury
  // destination is not the current SQL authority's chip-retirement bank proof.
  // Fresh native output is required before adding current lifecycle captures.
  it.each(fullLifecycleTerminalReceipts)(
    'refuses the historical $rake.accounting.status v2 treasury receipt',
    (receipt) => {
      const verified = verifyTournamentCompletionReceipt(
        receipt,
        receipt.tournament_id,
        'places',
        receipt.winner_id
      );
      expect(verified).toBeNull();
      expect(receipt.receipt_version).toBe(2);
      expect(receipt.rake.destination).toBe(
        `club_treasury:${receipt.rake.accounting.bank_club_id}`
      );
      expect(receipt.rake.accounting.bank_receipt_kind).toBe('chip_ledger');
      expect(receipt.rake.accounting.bank_union_id).toBeNull();
      expect(receipt.cash_payout_total).toBe(180);
      expect(receipt.rake.amount).toBe(20);
    }
  );
});
