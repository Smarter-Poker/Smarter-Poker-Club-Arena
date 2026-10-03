import { describe, expect, it } from 'vitest';
import { parseSettlementHistory } from '../../src/utils/settlementHistory';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  period_id: '22222222-2222-4222-8222-222222222222',
  invoice_type: 'union_to_club',
  gross_amount: '100.25',
  net_amount: '10.05',
  breakdown: { union_hold_amount: '10.05', club_retained: '90.20' },
  status: 'paid',
  created_at: '2026-10-03T12:00:00Z',
  ...overrides,
});

describe('parseSettlementHistory', () => {
  it('maps an exact-cent rake split whose net is the union hold', () => {
    expect(parseSettlementHistory([row()])).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        periodId: '22222222-2222-4222-8222-222222222222',
        totalRake: 100.25,
        unionTax: 10.05,
        netSettlement: 90.2,
        status: 'completed',
        createdAt: '2026-10-03T12:00:00Z',
        agentPayouts: 0,
      },
    ]);
  });

  it('accepts binary serialization dust in a duplicated historical split', () => {
    const parsed = parseSettlementHistory([
      row({
        gross_amount: '4719.32',
        net_amount: '471.93',
        breakdown: {
          union_hold_amount: '471.93',
          club_retained: 4247.389999999999,
        },
      }),
    ]);
    expect(parsed?.[0]).toMatchObject({
      totalRake: 4719.32,
      unionTax: 471.93,
      netSettlement: 4247.39,
    });
  });

  it('refuses a direction-only transfer document without rake-split mirrors', () => {
    expect(
      parseSettlementHistory([
        row({
          gross_amount: '485808.88',
          net_amount: '485808.88',
          breakdown: { category: 'rakeback' },
        }),
      ])
    ).toBeNull();
  });

  it.each([
    ['union hold', { club_retained: '90.20' }],
    ['club retained', { union_hold_amount: '10.05' }],
  ])('refuses a settlement missing its duplicated %s mirror', (_label, breakdown) => {
    expect(parseSettlementHistory([row({ breakdown })])).toBeNull();
  });

  it.each([
    ['gross amount', { gross_amount: '100.251' }],
    ['net amount', { net_amount: '10.051' }],
    ['union hold', { breakdown: { union_hold_amount: '10.051', club_retained: '90.20' } }],
    [
      'club retained amount',
      { breakdown: { union_hold_amount: '10.05', club_retained: '90.201' } },
    ],
  ])('refuses a non-cent %s', (_label, overrides) => {
    expect(parseSettlementHistory([row(overrides)])).toBeNull();
  });

  it('refuses a split that does not conserve gross rake', () => {
    expect(
      parseSettlementHistory([
        row({ breakdown: { union_hold_amount: '10.05', club_retained: '90.19' } }),
      ])
    ).toBeNull();
  });

  it('refuses a union hold that disagrees with net_amount', () => {
    expect(
      parseSettlementHistory([
        row({ breakdown: { union_hold_amount: '10.04', club_retained: '90.21' } }),
      ])
    ).toBeNull();
  });

  it('refuses an invoice outside the rake-hold read model', () => {
    expect(parseSettlementHistory([row({ invoice_type: 'union_club_pnl' })])).toBeNull();
  });

  it('refuses duplicate settlement identities', () => {
    expect(parseSettlementHistory([row(), row()])).toBeNull();
  });
});
