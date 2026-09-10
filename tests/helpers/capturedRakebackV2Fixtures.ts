import type {
  CapturedRakebackReadV2,
  CapturedRakebackClaimV2,
  CapturedScope,
  CashPayment,
  ScopeBalance,
} from '../../src/types/capturedRakeback';
export const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const CLUB = 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  CLUB2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const POOL = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  PAYMENT = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const HAND = '11111111-1111-1111-1111-111111111111',
  HAND2 = '22222222-2222-2222-2222-222222222222';
export const PAYMENT2 = '33333333-3333-3333-3333-333333333333',
  PAYER2 = '44444444-4444-4444-4444-444444444444';
export const scope = (overrides: Partial<CapturedScope> = {}): CapturedScope => ({
  club_id: CLUB,
  funding_union_id: null,
  funding_route: 'club_chip_treasury',
  contract_version: 1,
  payer_user_id: B,
  ...overrides,
});
export const payment = (amount = '7.01', overrides: Partial<CashPayment> = {}): CashPayment => ({
  payment_id: PAYMENT,
  scope: scope(),
  pool_id: POOL,
  beneficiary_user_id: A,
  amount,
  paid_at: '2026-09-09T12:34:56.123456Z',
  earning_closed_through: '2026-09-07',
  earning_slices: [
    {
      hand_id: HAND,
      contributor_id: A,
      week_start: '2026-08-31',
      amount_exact: amount.replace(/0+$/, '').replace(/\.$/, ''),
    },
  ],
  ...overrides,
});
export const balance = (overrides: Partial<ScopeBalance> = {}): ScopeBalance => ({
  scope: scope(),
  pool_id: POOL,
  closed_entitlement_exact: '10',
  consumed_exact: '7.01',
  unpaid_exact: '2.99',
  pending_amount: '2.99',
  paid_amount: '7.01',
  earning_weeks: [
    {
      week_start: '2026-08-31',
      week_end: '2026-09-06',
      closed: true,
      entitlement_exact: '10',
      consumed_exact: '7.01',
      remaining_exact: '2.99',
      source_count: 1,
      funding_admitted_source_count: 1,
    },
  ],
  ...overrides,
});
export const read = (overrides: Partial<CapturedRakebackReadV2> = {}): CapturedRakebackReadV2 => ({
  schema_version: 2,
  source_active: true,
  beneficiary_user_id: A,
  earning_closed_through: '2026-09-07',
  pending_amount: '2.99',
  paid_amount: '7.01',
  closed_entitlement_exact: '10',
  consumed_exact: '7.01',
  unpaid_exact: '2.99',
  balances: [balance()],
  cash_payments: [payment()],
  unresolved_earnings: [],
  source_final: false,
  ...overrides,
});
export const inactive = (user = A): CapturedRakebackReadV2 =>
  read({
    source_active: false,
    beneficiary_user_id: user,
    pending_amount: '0.00',
    paid_amount: '0.00',
    closed_entitlement_exact: '0',
    consumed_exact: '0',
    unpaid_exact: '0',
    balances: [],
    cash_payments: [],
  });
export const unpaid = (
  exact = '0.006',
  pending = '0.00',
  overrides: Partial<ScopeBalance> = {}
): ScopeBalance =>
  balance({
    closed_entitlement_exact: exact,
    consumed_exact: '0',
    unpaid_exact: exact,
    pending_amount: pending,
    paid_amount: '0.00',
    earning_weeks: [
      {
        week_start: '2026-08-31',
        week_end: '2026-09-06',
        closed: true,
        entitlement_exact: exact,
        consumed_exact: '0',
        remaining_exact: exact,
        source_count: 1,
        funding_admitted_source_count: 0,
      },
    ],
    ...overrides,
  });
export const fractionRead = (): CapturedRakebackReadV2 =>
  read({
    pending_amount: '0.00',
    paid_amount: '0.00',
    closed_entitlement_exact: '0.006',
    consumed_exact: '0',
    unpaid_exact: '0.006',
    balances: [unpaid()],
    cash_payments: [],
  });
export const carryRead = (): CapturedRakebackReadV2 =>
  read({
    pending_amount: '0.00',
    paid_amount: '0.01',
    closed_entitlement_exact: '0.012',
    consumed_exact: '0.01',
    unpaid_exact: '0.002',
    balances: [
      balance({
        closed_entitlement_exact: '0.012',
        consumed_exact: '0.01',
        unpaid_exact: '0.002',
        pending_amount: '0.00',
        paid_amount: '0.01',
        earning_weeks: [
          {
            week_start: '2026-08-24',
            week_end: '2026-08-30',
            closed: true,
            entitlement_exact: '0.006',
            consumed_exact: '0.006',
            remaining_exact: '0',
            source_count: 1,
            funding_admitted_source_count: 1,
          },
          {
            week_start: '2026-08-31',
            week_end: '2026-09-06',
            closed: true,
            entitlement_exact: '0.006',
            consumed_exact: '0.004',
            remaining_exact: '0.002',
            source_count: 1,
            funding_admitted_source_count: 1,
          },
        ],
      }),
    ],
    cash_payments: [
      payment('0.01', {
        earning_slices: [
          { hand_id: HAND, contributor_id: A, week_start: '2026-08-24', amount_exact: '0.006' },
          { hand_id: HAND2, contributor_id: A, week_start: '2026-08-31', amount_exact: '0.004' },
        ],
      }),
    ],
  });
export const paidRead = (): CapturedRakebackReadV2 =>
  read({
    pending_amount: '0.00',
    paid_amount: '10.00',
    consumed_exact: '10',
    unpaid_exact: '0',
    balances: [
      balance({
        pending_amount: '0.00',
        paid_amount: '10.00',
        consumed_exact: '10',
        unpaid_exact: '0',
        earning_weeks: [
          { ...balance().earning_weeks[0], consumed_exact: '10', remaining_exact: '0' },
        ],
      }),
    ],
    cash_payments: [
      payment('10.00', {
        earning_slices: [
          { hand_id: HAND, contributor_id: A, week_start: '2026-08-31', amount_exact: '10' },
        ],
      }),
    ],
  });
export const claim = (
  requestId: string,
  amount = '2.99',
  overrides: Partial<CapturedRakebackClaimV2> = {}
): CapturedRakebackClaimV2 => ({
  schema_version: 2,
  success: true,
  request_id: requestId,
  beneficiary_user_id: A,
  club_id: null,
  earning_closed_through: '2026-09-07',
  new_payout: amount,
  payment_count: amount === '0.00' ? 0 : 1,
  payments: amount === '0.00' ? [] : [payment(amount, { payment_id: PAYMENT2 })],
  scopes: [
    {
      scope: scope(),
      pool_id: POOL,
      new_payout: amount,
      payment_ids: amount === '0.00' ? [] : [PAYMENT2],
      deferred: [],
    },
  ],
  source_final: false,
  ...overrides,
});
