import { describe, expect, it } from 'vitest';
import { verifySatelliteSettlementReceipt } from './satelliteSettlementReceipt.js';

const TOURNAMENT = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-000000000002';
const WINNER = '00000000-0000-4000-8000-000000000003';
const SECOND = '00000000-0000-4000-8000-000000000004';
const BUBBLE = '00000000-0000-4000-8000-000000000005';
const PAYOUT_ONE = '00000000-0000-4000-8000-000000000006';
const PAYOUT_TWO = '00000000-0000-4000-8000-000000000007';
const SEAT_ONE = '00000000-0000-4000-8000-000000000008';
const SOURCE_TABLE = '00000000-0000-4000-8000-000000000009';
const SOURCE_SEAT_ONE = '00000000-0000-4000-8000-00000000000a';
const SOURCE_SEAT_TWO = '00000000-0000-4000-8000-00000000000b';

function receipt() {
  return {
    receipt_version: 2,
    ok: true,
    fully_settled: true,
    status: 'COMPLETED',
    tournament_id: TOURNAMENT,
    target_id: TARGET,
    winner_id: WINNER,
    field_size: 4,
    pool: 485,
    ticket_cost: 200,
    ticket_award_count: 2,
    seat_count: 1,
    cash_ticket_count: 1,
    awards: [
      {
        user_id: WINNER,
        position: 1,
        amount: 200,
        delivery_kind: 'seat',
        payout_id: PAYOUT_ONE,
        registration_id: SEAT_ONE,
      },
      {
        user_id: SECOND,
        position: 2,
        amount: 200,
        delivery_kind: 'cash',
        payout_id: PAYOUT_TWO,
        registration_id: null,
      },
    ],
    seats: [{ user_id: WINNER, position: 1, amount: 200, registration_id: SEAT_ONE }],
    remainder: { user_id: BUBBLE, position: 3, amount: 85 },
    winner_amount: 200,
    source_table_count: 1,
    source_seat_count: 2,
    released_seat_count: 2,
    source_closeout: {
      source_table_count: 1,
      source_table_ids: [SOURCE_TABLE],
      source_seat_count: 2,
      source_seat_ids: [SOURCE_SEAT_ONE, SOURCE_SEAT_TWO],
      released_seat_count: 2,
      released_seat_ids: [SOURCE_SEAT_ONE, SOURCE_SEAT_TWO],
      closed_at: '2026-09-08T04:00:00.000Z',
    },
    settled_at: '2026-09-08T04:00:00.000Z',
  };
}

describe('atomic satellite settlement receipt', () => {
  it('accepts exact seat and cash ticket deliveries followed by one bubble residual', () => {
    const result = verifySatelliteSettlementReceipt(receipt(), TOURNAMENT, WINNER);
    expect(result).toMatchObject({
      receiptVersion: 2,
      ticketAwardCount: 2,
      seatCount: 1,
      cashTicketCount: 1,
      pool: 485,
      ticketCost: 200,
      awards: [
        { position: 1, deliveryKind: 'seat', amount: 200 },
        { position: 2, deliveryKind: 'cash', amount: 200 },
      ],
      remainder: { userId: BUBBLE, position: 3, amount: 85 },
      winnerAmount: 200,
      sourceCloseout: {
        sourceTableCount: 1,
        sourceTableIds: [SOURCE_TABLE],
        sourceSeatCount: 2,
        sourceSeatIds: [SOURCE_SEAT_ONE, SOURCE_SEAT_TWO],
        releasedSeatCount: 2,
        releasedSeatIds: [SOURCE_SEAT_ONE, SOURCE_SEAT_TWO],
      },
    });
  });

  it('accepts an all-cash ticket receipt when the target is definitively unavailable', () => {
    const allCash = {
      ...receipt(),
      seat_count: 0,
      cash_ticket_count: 2,
      awards: receipt().awards.map((award) => ({
        ...award,
        delivery_kind: 'cash',
        registration_id: null,
      })),
      seats: [],
    };
    const result = verifySatelliteSettlementReceipt(allCash, TOURNAMENT, WINNER);
    expect(result?.cashTicketCount).toBe(2);
    expect(result?.seats).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['unknown future', 3],
    ['retired prior', 1],
  ])('refuses a %s receipt version', (_name, receiptVersion) => {
    expect(
      verifySatelliteSettlementReceipt(
        { ...receipt(), receipt_version: receiptVersion },
        TOURNAMENT,
        WINNER
      )
    ).toBeNull();
  });

  it.each([
    ['non-UUID target', { target_id: 'target' }],
    [
      'non-UUID payout evidence',
      { awards: [{ ...receipt().awards[0], payout_id: 'payout' }, receipt().awards[1]] },
    ],
    ['missing settlement time', { settled_at: undefined }],
    ['invalid settlement time', { settled_at: 'not-a-time' }],
  ])('refuses %s', (_name, patch) => {
    expect(
      verifySatelliteSettlementReceipt({ ...receipt(), ...patch }, TOURNAMENT, WINNER)
    ).toBeNull();
  });

  it('accepts a below-ticket pool only when first place is the sole bubble', () => {
    const result = verifySatelliteSettlementReceipt(
      {
        ...receipt(),
        field_size: 3,
        pool: 85,
        ticket_award_count: 0,
        seat_count: 0,
        cash_ticket_count: 0,
        awards: [],
        seats: [],
        remainder: { user_id: WINNER, position: 1, amount: 85 },
        winner_amount: 85,
      },
      TOURNAMENT,
      WINNER
    );
    expect(result?.remainder).toEqual({ userId: WINNER, position: 1, amount: 85 });
  });

  it.each([
    ['split remainder', { remainder: { user_id: BUBBLE, position: 3, amount: 40 } }],
    [
      'remainder sent to a ticket winner',
      { remainder: { user_id: SECOND, position: 3, amount: 85 } },
    ],
    ['bubble before all full tickets', { remainder: { user_id: BUBBLE, position: 2, amount: 85 } }],
    [
      'award count below floor(pool / ticket)',
      {
        ticket_award_count: 1,
        cash_ticket_count: 0,
        awards: [receipt().awards[0]],
        remainder: { user_id: SECOND, position: 2, amount: 285 },
      },
    ],
    ['invented ticket award', { ticket_award_count: 3 }],
    ['delivery counts disagree', { seat_count: 2 }],
    [
      'ticket underfunded',
      {
        awards: [{ ...receipt().awards[0], amount: 150 }, receipt().awards[1]],
      },
    ],
    [
      'cash delivery claims a registration',
      {
        awards: [
          receipt().awards[0],
          { ...receipt().awards[1], registration_id: 'not-a-cash-receipt' },
        ],
      },
    ],
    ['nonterminal result', { status: 'COMPLETING' }],
    ['wrong winner', { winner_id: SECOND }],
    ['missing source closeout', { source_closeout: undefined }],
    ['zero source tables', { source_table_count: 0 }],
    [
      'source table count mismatch',
      { source_closeout: { ...receipt().source_closeout, source_table_count: 2 } },
    ],
    [
      'duplicate source seat identity',
      {
        source_closeout: {
          ...receipt().source_closeout,
          source_seat_ids: [SOURCE_SEAT_ONE, SOURCE_SEAT_ONE],
        },
      },
    ],
    [
      'released seat outside source snapshot',
      {
        source_closeout: {
          ...receipt().source_closeout,
          released_seat_ids: [SOURCE_SEAT_ONE, SEAT_ONE],
        },
      },
    ],
    [
      'closeout from a different transaction',
      {
        source_closeout: {
          ...receipt().source_closeout,
          closed_at: '2026-09-08T04:00:01.000Z',
        },
      },
    ],
  ])('refuses %s', (_name, patch) => {
    expect(
      verifySatelliteSettlementReceipt({ ...receipt(), ...patch }, TOURNAMENT, WINNER)
    ).toBeNull();
  });

  it('requires null remainder when the pool divides into full tickets exactly', () => {
    const exact = { ...receipt(), pool: 400, remainder: null };
    expect(verifySatelliteSettlementReceipt(exact, TOURNAMENT, WINNER)).not.toBeNull();
    expect(
      verifySatelliteSettlementReceipt(
        { ...exact, remainder: { user_id: BUBBLE, position: 3, amount: 0 } },
        TOURNAMENT,
        WINNER
      )
    ).toBeNull();
  });
});
