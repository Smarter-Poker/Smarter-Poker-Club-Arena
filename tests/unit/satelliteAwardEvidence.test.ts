import { satelliteAwardTotalLabel } from '../../src/components/tournament/details/useSatelliteAwards';
import { describe, expect, it } from 'vitest';
import {
  recordedSatelliteAwardKind,
  type SatellitePayoutEvidence,
} from '../../src/components/tournament/details/satelliteAwardEvidence';
const target = '22222222-2222-4222-8222-222222222222';
const receipt: SatellitePayoutEvidence = {
  id: 'r1',
  tournament_id: 'event',
  user_id: 'winner',
  source: 'satellite_seat',
  amount: 35,
  recorded_by: 'settlement',
  metadata: { satellite_target_id: target },
};
const kind = (rows = [receipt], amount: unknown = 35) =>
  recordedSatelliteAwardKind(rows, 'event', target, 'winner', amount);
describe('recorded satellite delivery evidence', () => {
  it('recognizes a delivered seat and a stored ticket, preserving numeric strings', () => {
    expect(kind()).toBe('ticket');
    expect(
      kind([
        {
          ...receipt,
          amount: '35',
          source: 'satellite_ticket',
          metadata: {
            satellite_target_id: target,
            delivery_kind: 'ticket',
            ticket_id: '33333333-3333-4333-8333-333333333333',
          },
        },
      ])
    ).toBe('ticket');
  });
  it('recognizes the maintained cash writer and bubble remainder', () => {
    expect(
      kind([
        { ...receipt, source: 'satellite_ticket', recorded_by: 'credit_and_log', metadata: null },
      ])
    ).toBe('cash');
    expect(kind([{ ...receipt, source: 'satellite_remainder', metadata: null }])).toBe('cash');
  });
  it.each([
    { tournament_id: 'other' },
    { user_id: 'other' },
    { amount: 30 },
    { metadata: { satellite_target_id: 'other' } },
    { metadata: null },
    {
      source: 'satellite_ticket',
      metadata: { satellite_target_id: target, delivery_kind: 'ticket', ticket_id: 'missing' },
    },
    {
      source: 'satellite_ticket',
      metadata: { satellite_target_id: target, delivery_kind: 'cash' },
    },
  ])('does not infer a ticket from missing or mismatched evidence %j', (patch) => {
    expect(kind([{ ...receipt, ...patch }])).toBe('unknown');
  });
  it('keeps missing, conflicting and invalid amounts unknown', () => {
    expect(kind([])).toBe('unknown');
    expect(kind([receipt, { ...receipt, id: 'r2', source: 'satellite_remainder' }])).toBe(
      'unknown'
    );
    for (const value of [0, -1, 'bad', Infinity, null])
      expect(kind([receipt], value)).toBe('unknown');
  });
});

it('keeps a ticket separate from cash bounty when a satellite result is totaled', () => {
  expect(satelliteAwardTotalLabel('ticket', 35, 4, String)).toBe('1 Ticket (35) + Cash 4');
  expect(satelliteAwardTotalLabel('cash', 3, 2, String)).toBe('Cash 5');
  expect(satelliteAwardTotalLabel('unknown', 35, 2, String)).toBe('Value 37');
  expect(satelliteAwardTotalLabel('unknown', 0, 5, String)).toBe('Cash 5');
});
