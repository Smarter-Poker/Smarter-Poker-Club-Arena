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
const ENTRY_TICKET_TWO = '00000000-0000-4000-8000-00000000000c';
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
    entry_ticket_count: 0,
    awards: [
      {
        user_id: WINNER,
        position: 1,
        amount: 200,
        delivery_kind: 'seat',
        payout_id: PAYOUT_ONE,
        registration_id: SEAT_ONE,
        ticket_id: null,
      },
      {
        user_id: SECOND,
        position: 2,
        amount: 200,
        delivery_kind: 'cash',
        payout_id: PAYOUT_TWO,
        registration_id: null,
        ticket_id: null,
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
      entryTicketCount: 0,
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

  it('accepts finite decimal numeric strings returned by the database transport', () => {
    const transported = receipt();
    const result = verifySatelliteSettlementReceipt(
      {
        ...transported,
        field_size: '4',
        pool: '485.00',
        ticket_cost: '200',
        ticket_award_count: '2',
        seat_count: '1',
        cash_ticket_count: '1',
        entry_ticket_count: '0',
        awards: transported.awards.map((award) => ({
          ...award,
          position: String(award.position),
          amount: String(award.amount),
        })),
        seats: transported.seats.map((seat) => ({
          ...seat,
          position: String(seat.position),
          amount: String(seat.amount),
        })),
        remainder: {
          ...transported.remainder,
          position: String(transported.remainder.position),
          amount: String(transported.remainder.amount),
        },
        winner_amount: '200.0',
        source_table_count: '1',
        source_seat_count: '2',
        released_seat_count: '2',
        source_closeout: {
          ...transported.source_closeout,
          source_table_count: '1',
          source_seat_count: '2',
          released_seat_count: '2',
        },
      },
      TOURNAMENT,
      WINNER
    );

    expect(result).not.toBeNull();
  });

  it.each([
    ['null', null, 0],
    ['blank string', '', 0],
    ['whitespace string', '   ', 0],
    ['space-padded string', ' 85 ', 85],
    ['hexadecimal string', '0x55', 85],
    ['exponent string', '8.5e1', 85],
    ['true', true, 1],
    ['false', false, 0],
    ['array', [85], 85],
    ['object', { value: 85 }, null],
  ])(
    'refuses %s for an exact-money field before numeric conversion',
    (_name, value, coercedAmount) => {
      const expectedAmount = coercedAmount ?? 0;
      const noTicketReceipt = {
        ...receipt(),
        field_size: 1,
        pool: value,
        ticket_award_count: 0,
        seat_count: 0,
        cash_ticket_count: 0,
        entry_ticket_count: 0,
        awards: [],
        seats: [],
        remainder:
          expectedAmount === 0 ? null : { user_id: WINNER, position: 1, amount: expectedAmount },
        winner_amount: expectedAmount,
      };

      expect(verifySatelliteSettlementReceipt(noTicketReceipt, TOURNAMENT, WINNER)).toBeNull();
    }
  );

  it.each([
    ['null', null, 0],
    ['blank string', '', 0],
    ['whitespace string', '   ', 0],
    ['space-padded string', ' 2 ', 2],
    ['hexadecimal string', '0x2', 2],
    ['exponent string', '2e0', 2],
    ['true', true, 1],
    ['false', false, 0],
    ['array', [2], 2],
    ['object', { value: 2 }, null],
  ])('refuses %s for an integer field before numeric conversion', (_name, value, coercedCount) => {
    const expectedCount = coercedCount ?? 2;
    const releasedSeatIds = [SOURCE_SEAT_ONE, SOURCE_SEAT_TWO].slice(0, expectedCount);
    expect(
      verifySatelliteSettlementReceipt(
        {
          ...receipt(),
          released_seat_count: value,
          source_closeout: {
            ...receipt().source_closeout,
            released_seat_count: expectedCount,
            released_seat_ids: releasedSeatIds,
          },
        },
        TOURNAMENT,
        WINNER
      )
    ).toBeNull();
  });

  it('accepts zero as a numeric string for a non-negative integer field', () => {
    expect(
      verifySatelliteSettlementReceipt(
        {
          ...receipt(),
          released_seat_count: '0',
          source_closeout: {
            ...receipt().source_closeout,
            released_seat_count: '0',
            released_seat_ids: [],
          },
        },
        TOURNAMENT,
        WINNER
      )
    ).not.toBeNull();
  });

  it.each([
    ['numeric-looking zero', '0'],
    ['date only', '2026-09-08'],
    ['space separator', '2026-09-08 04:00:00Z'],
    ['missing timezone', '2026-09-08T04:00:00'],
    ['lowercase separators', '2026-09-08t04:00:00z'],
  ])('refuses a %s settlement timestamp', (_name, timestamp) => {
    expect(
      verifySatelliteSettlementReceipt(
        {
          ...receipt(),
          source_closeout: { ...receipt().source_closeout, closed_at: timestamp },
          settled_at: timestamp,
        },
        TOURNAMENT,
        WINNER
      )
    ).toBeNull();
  });

  it('accepts canonical RFC3339 timestamps with a numeric timezone offset', () => {
    const timestamp = '2026-09-08T04:00:00.123456+00:00';
    expect(
      verifySatelliteSettlementReceipt(
        {
          ...receipt(),
          source_closeout: { ...receipt().source_closeout, closed_at: timestamp },
          settled_at: timestamp,
        },
        TOURNAMENT,
        WINNER
      )
    ).not.toBeNull();
  });

  it('accepts a historical source close that predates the immutable adoption receipt', () => {
    expect(
      verifySatelliteSettlementReceipt(
        {
          ...receipt(),
          source_closeout: {
            ...receipt().source_closeout,
            closed_at: '2026-09-07T04:00:00.000Z',
          },
          settled_at: '2026-09-08T04:00:00.000Z',
        },
        TOURNAMENT,
        WINNER
      )
    ).not.toBeNull();
  });

  it('accepts an all-cash ticket receipt when the target is definitively unavailable', () => {
    const allCash = {
      ...receipt(),
      seat_count: 0,
      cash_ticket_count: 2,
      entry_ticket_count: 0,
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

  it('accepts an exact target-scoped noncash ticket delivery', () => {
    const directTicket = {
      ...receipt(),
      cash_ticket_count: 0,
      entry_ticket_count: 1,
      awards: [
        receipt().awards[0],
        {
          ...receipt().awards[1],
          delivery_kind: 'ticket',
          ticket_id: ENTRY_TICKET_TWO,
        },
      ],
    };

    const result = verifySatelliteSettlementReceipt(directTicket, TOURNAMENT, WINNER);
    expect(result?.entryTicketCount).toBe(1);
    expect(result?.awards[1]).toMatchObject({
      position: 2,
      deliveryKind: 'ticket',
      registrationId: null,
      ticketId: ENTRY_TICKET_TWO,
    });
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
        entry_ticket_count: 0,
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
    ['ticket count disagrees', { entry_ticket_count: 1 }],
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
    [
      'ticket delivery omits its immutable ticket id',
      {
        cash_ticket_count: 0,
        entry_ticket_count: 1,
        awards: [
          receipt().awards[0],
          { ...receipt().awards[1], delivery_kind: 'ticket', ticket_id: null },
        ],
      },
    ],
    [
      'cash delivery claims a ticket id',
      {
        awards: [receipt().awards[0], { ...receipt().awards[1], ticket_id: ENTRY_TICKET_TWO }],
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
      'source closeout after its settlement receipt',
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

// These transport objects were emitted by the real isolated PG17 payer after
// authenticated source funding, entry close and exact target escrow funding.
import nativeCohorts from './__fixtures__/satellite-qualifier-native-receipts.json';
import { verifySatelliteQualifierReceipt } from './satelliteQualifierReceipt.js';

describe('versioned satellite qualifier receipts keep equal winners unranked', () => {
  it.each(Object.entries(nativeCohorts))('accepts the actual %s terminal receipt', (_name, raw) => {
    const verified = verifySatelliteQualifierReceipt(raw, raw.tournament_id, raw.qualifier_ids);
    expect(verified).not.toBeNull();
    expect(verified?.qualifierIds).toEqual(raw.qualifier_ids);
    expect(
      verified?.awards
        .filter((award) => raw.qualifier_ids.includes(award.userId))
        .every((award) => award.position === null)
    ).toBe(true);
    expect(verified?.remainder).toMatchObject({ position: 3, amount: 5 });
    expect(verified?.ticketAwardCount).toBe(2);
    expect(verified).not.toHaveProperty('winnerId');
  });

  it.each([
    'ranked-survivor',
    'wrong-cohort',
    'duplicate-slot',
    'fake-champion',
    'wrong-overflow',
    'unpaid-remainder',
    'unclosed-felt',
  ])('rejects %s instead of manufacturing a terminal outcome', (fault) => {
    const raw: any = structuredClone(nativeCohorts.same_hand_overflow);
    if (fault === 'ranked-survivor') raw.awards[0].position = 1;
    if (fault === 'wrong-cohort') raw.qualifier_ids = [raw.awards[1].user_id];
    if (fault === 'duplicate-slot') raw.awards[1].award_slot = 1;
    if (fault === 'fake-champion') raw.winner_id = raw.qualifier_ids[0];
    if (fault === 'wrong-overflow') raw.awards[1].position = 3;
    if (fault === 'unpaid-remainder') raw.remainder.amount = 0;
    if (fault === 'unclosed-felt') raw.source_closeout.source_table_ids = [];
    expect(
      verifySatelliteQualifierReceipt(
        raw,
        raw.tournament_id,
        nativeCohorts.same_hand_overflow.qualifier_ids
      )
    ).toBeNull();
  });
});
