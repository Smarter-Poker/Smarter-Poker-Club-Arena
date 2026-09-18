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

describe('bounded original fee custody terminal receipts', () => {
  const id = 'f370585d-40ea-4085-bb8f-c7e8c74f3fb4';
  function custodyReceipt(): any {
    const r = receipt();
    r.tournament_id = id;
    r.receipt_version = 3;
    r.fully_settled = false;
    r.player_result = 'final';
    r.accounting_complete = false;
    r.accounting_state = 'fee_custody_unresolved';
    r.rake = {
      amount: 17,
      destination: 'tournament_escrow',
      attributed: false,
      attributed_users: 0,
      settled_at: null,
      attributed_at: null,
      accounting: {
        accounting_version: 3,
        tournament_id: id,
        status: 'fee_custody_unresolved',
        player_result: 'final',
        payable: false,
        accounting_complete: false,
        obligation_id: TABLE_ID,
        source_fingerprint: 'f67bf12ee0b00c954b6f8403de9718fe',
        source_count: 34,
        held_amount: 17,
        current_held_amount: 17,
        held_at: r.settled_at,
        reason: 'tournament_fee_sources_require_reconciliation',
        custody_store: 'tournament_escrow',
        recognized_source_count: 0,
        bank_amount: 0,
        banked_at: null,
        bank_receipt_id: null,
        resolution: null,
      },
    };
    r.escrow = {
      prize_balance: 0,
      bounty_balance: 0,
      fee_balance: 17,
      closed_at: null,
      close_note: null,
    };
    return r;
  }
  it('accepts exact final player result while preserving 17 original fee chips', () => {
    const parsed = verifyTournamentCompletionReceipt(custodyReceipt(), id, 'places', WINNER_ID);
    expect(parsed?.rake).toMatchObject({
      amount: 17,
      destination: 'tournament_escrow',
      accountingState: 'fee_custody_unresolved',
      settledAt: null,
      attributedAt: null,
    });
    expect(parsed?.payouts).toHaveLength(2);
  });
  it.each([
    [
      'foreign event',
      (r: any) => {
        r.tournament_id = TOURNAMENT_ID;
        r.rake.accounting.tournament_id = TOURNAMENT_ID;
      },
    ],
    [
      'changed original source',
      (r: any) => {
        r.rake.accounting.source_fingerprint = '0'.repeat(32);
      },
    ],
    [
      'changed held money',
      (r: any) => {
        r.escrow.fee_balance = 16.99;
      },
    ],
    [
      'false bank date',
      (r: any) => {
        r.rake.settled_at = r.settled_at;
      },
    ],
    [
      'false attribution',
      (r: any) => {
        r.rake.attributed = true;
      },
    ],
    [
      'fake financial completion',
      (r: any) => {
        r.fully_settled = true;
      },
    ],
    [
      'missing custody identity',
      (r: any) => {
        r.rake.accounting.obligation_id = null;
      },
    ],
    [
      'unknown error laundering',
      (r: any) => {
        r.rake.accounting.reason = 'wallet_short';
      },
    ],
    [
      'unpaid player prize',
      (r: any) => {
        r.escrow.prize_balance = 1;
      },
    ],
    [
      'unpaid player bounty',
      (r: any) => {
        r.escrow.bounty_balance = 1;
      },
    ],
    [
      'missing source count',
      (r: any) => {
        r.rake.accounting.source_count = 0;
      },
    ],
    [
      'late original custody',
      (r: any) => {
        r.rake.accounting.held_at = '2026-09-09T05:00:00.000Z';
      },
    ],
    [
      'false closed escrow',
      (r: any) => {
        r.escrow.closed_at = r.settled_at;
      },
    ],
  ])('refuses %s', (_label, change) => {
    const r = custodyReceipt();
    change(r);
    expect(verifyTournamentCompletionReceipt(r, r.tournament_id, 'places', WINNER_ID)).toBeNull();
  });
  it.each([
    ['1ffbd637-9241-4957-902f-3a75e09892c0', 127.5, '53fd19518004de9991312c0aaa749705', 85],
    ['8fc76450-534a-4877-97b5-8f784a3d5daa', 127.5, '87fd65baf92f74a1de5c85ed09844c62', 85],
    ['2421c66f-6f02-40a2-8414-23379802ce23', 69, '0dd99b682fed61573e47a2e0f8e57ab8', 46],
    ['199a71a9-f364-4e90-a3ba-3cdcfb7755bc', 1.2, 'ceeb0817a40a48f9e7cfdac3883036b7', 1],
    ['808ef798-0942-4ce0-9ae1-eeefaaf4b0a9', 0.48, '13f274f32c3ae9ca27da9991d013e33e', 1],
    ['b60c7add-6b38-4549-b091-601f64d118a0', 0.24, '03b471964aaef196d4dddec3f73e64f8', 1],
    ['e3f4e2ab-8397-43e8-8643-6cec3fff3a63', 4.8, 'cac905b2c20f288a272e04bc65d0b259', 1],
    ['f3f050f1-569e-4fb6-859f-86b6092e682e', 4.8, 'a64cf2abd9d146390b482bd4aff9cd3e', 1],
  ])(
    'accepts only the separately named original fee proof %s',
    (event, amount, fingerprint, count) => {
      const r = custodyReceipt();
      r.tournament_id = event;
      r.rake.amount = amount;
      r.escrow.fee_balance = amount;
      Object.assign(r.rake.accounting, {
        tournament_id: event,
        held_amount: amount,
        current_held_amount: amount,
        source_fingerprint: fingerprint,
        source_count: count,
      });
      expect(
        verifyTournamentCompletionReceipt(r, String(event), 'places', WINNER_ID)?.rake.amount
      ).toBe(amount);
      r.rake.accounting.source_fingerprint = '0'.repeat(32);
      expect(verifyTournamentCompletionReceipt(r, String(event), 'places', WINNER_ID)).toBeNull();
    }
  );
  it('accepts an exact later recognition while preserving the original terminal header', () => {
    const r = custodyReceipt();
    r.fully_settled = true;
    r.accounting_complete = true;
    r.accounting_state = 'recognized';
    r.escrow.fee_balance = 0;
    r.rake.accounting.accounting_complete = true;
    r.rake.accounting.current_held_amount = 0;
    r.rake.accounting.resolution = {
      accounting_version: 2,
      tournament_id: id,
      status: 'recognized',
      payable: true,
      source_fingerprint: r.rake.accounting.source_fingerprint,
      recognized_source_count: 34,
      bank_amount: 17,
      banked_at: '2026-09-09T05:00:00.000Z',
      bank_receipt_id: SEAT_A_ID,
      bank_club_id: SEAT_B_ID,
      bank_union_id: null,
      bank_receipt_kind: 'chip_ledger',
    };
    expect(
      verifyTournamentCompletionReceipt(r, id, 'places', WINNER_ID)?.rake.accountingState
    ).toBe('recognized');
    // One Spin fee record covers three original paid contributors.
    const spin = structuredClone(r);
    spin.tournament_id = '199a71a9-f364-4e90-a3ba-3cdcfb7755bc';
    spin.rake.amount = 1.2;
    Object.assign(spin.rake.accounting, {
      tournament_id: spin.tournament_id,
      held_amount: 1.2,
      source_count: 1,
      source_fingerprint: 'ceeb0817a40a48f9e7cfdac3883036b7',
    });
    Object.assign(spin.rake.accounting.resolution, {
      tournament_id: spin.tournament_id,
      source_fingerprint: spin.rake.accounting.source_fingerprint,
      bank_amount: 1.2,
      recognized_source_count: 3,
    });
    expect(
      verifyTournamentCompletionReceipt(spin, spin.tournament_id, 'places', WINNER_ID)?.rake
        .accountingState
    ).toBe('recognized');
    spin.rake.accounting.resolution.recognized_source_count = 1;
    expect(
      verifyTournamentCompletionReceipt(spin, spin.tournament_id, 'places', WINNER_ID)
    ).toBeNull();
    const changed = structuredClone(r);
    changed.rake.accounting.resolution.recognized_source_count = 1;
    expect(verifyTournamentCompletionReceipt(changed, id, 'places', WINNER_ID)).toBeNull();
    changed.rake.accounting.resolution.recognized_source_count = 34;
    changed.rake.accounting.resolution.bank_amount = 16.99;
    expect(verifyTournamentCompletionReceipt(changed, id, 'places', WINNER_ID)).toBeNull();
    changed.rake.accounting.resolution.bank_amount = 17;
    changed.rake.accounting.resolution.source_fingerprint = '0'.repeat(32);
    expect(verifyTournamentCompletionReceipt(changed, id, 'places', WINNER_ID)).toBeNull();
  });
});
