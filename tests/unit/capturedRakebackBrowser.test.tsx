import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import nativeClaim from '../fixtures/captured-rakeback-v2/native-claim-paid-v2.json';
import nativeCrossWeek from '../fixtures/captured-rakeback-v2/native-read-cross-week-payment.json';
import nativePrebank from '../fixtures/captured-rakeback-v2/native-read-prebank.json';
import { cashRefreshAmount } from '../../src/services/CapturedRakebackV2';
import RakebackPage from '../../src/pages/RakebackPage';
import {
  claimCapturedRakeback,
  observeRakebackActivation,
  parseCapturedRakeback,
  prepareRakebackRequest,
  readRakebackRequests,
} from '../../src/services/CapturedRakebackService';

const mocks = vi.hoisted(() => ({
  userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  rpc: vi.fn(),
  legacy: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mocks.rpc(...args),
    from: () => ({
      select: () => ({
        eq: (_field: string, userId: string) => ({
          order: () => ({ limit: () => mocks.legacy(userId) }),
        }),
      }),
    }),
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => undefined }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => undefined }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mocks.emit, subscribeDebounced: () => () => undefined },
}));
vi.mock('../../src/components/common/EmptyState', () => ({
  ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <div role="alert">
      {message}
      <button onClick={onRetry}>Retry Balance</button>
    </div>
  ),
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({
  default: () => <p>Loading History</p>,
}));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: ({ metrics }: { metrics: { label: string; value: string }[] }) => (
    <section>
      {metrics.map((metric) => (
        <output key={metric.label} aria-label={metric.label}>
          {metric.value}
        </output>
      ))}
    </section>
  ),
}));
vi.mock('recharts', () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BarChart: Container,
    ResponsiveContainer: Container,
    Bar: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    CartesianGrid: () => null,
  };
});

import {
  A,
  B,
  CLUB,
  CLUB2,
  POOL,
  PAYMENT,
  HAND2,
  PAYMENT2,
  PAYER2,
  scope,
  balance,
  payment,
  read,
  inactive,
  unpaid,
  fractionRead,
  carryRead,
  paidRead,
  claim as claimResult,
} from '../helpers/capturedRakebackV2Fixtures';
import {
  parseCapturedRakebackClaim,
  formatRakebackCash,
} from '../../src/services/CapturedRakebackV2';
import type {
  CapturedRakebackReadV2,
  CapturedRakebackClaimV2,
} from '../../src/types/capturedRakeback';

function source(data = read(), actor = mocks.userId) {
  const value = structuredClone(data);
  value.beneficiary_user_id = actor;
  if (actor === B)
    for (const balance of value.balances)
      if (balance.scope.payer_user_id === B) balance.scope.payer_user_id = A;
  for (const receipt of value.cash_payments) {
    receipt.beneficiary_user_id = actor;
    if (actor === B && receipt.scope.payer_user_id === B) receipt.scope.payer_user_id = A;
    for (const slice of receipt.earning_slices) slice.contributor_id = actor;
  }
  return { data: value, error: null };
}
function receipt(requestId: string, amount = '2.99') {
  return { data: claimResult(requestId, amount), error: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const parse = (value: unknown) => parseCapturedRakeback(value, A);
const savedRequest = { requestId: B, expectedUserId: A, clubId: null };
function mutations() {
  return mocks.rpc.mock.calls.filter(
    ([name]) => name === 'fn_claim_captured_rakeback' || name === 'fn_claim_rakeback'
  );
}
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Claim Rakeback' })).toBeEnabled());
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  mocks.userId = A;
  mocks.legacy.mockResolvedValue({
    data: [
      {
        id: 'legacy-paid',
        club_id: CLUB,
        period_start: '2026-08-31',
        period_end: '2026-09-06',
        rake_generated: 9990,
        rakeback_rate: 0.1,
        rakeback_earned: 999,
        status: 'paid',
      },
    ],
    error: null,
  });
  mocks.rpc.mockImplementation((name: string, args: { p_request_id: string }) => {
    if (name === 'fn_get_captured_rakeback') return Promise.resolve(source());
    if (name === 'fn_claim_captured_rakeback') return Promise.resolve(receipt(args.p_request_id));
    throw new Error('Unexpected RPC ' + name);
  });
});
afterEach(cleanup);

describe('Captured Rakeback V2 Exact Contract', () => {
  it('reconciles two closed fractional weeks against one actual payment without weekly cash rounding', () => {
    const result = parse(carryRead());
    expect(result.closed_entitlement_exact).toBe('0.012');
    expect(result.paid_amount).toBe('0.01');
    expect(result.unpaid_exact).toBe('0.002');
    expect(result.balances[0].earning_weeks.map((w) => w.consumed_exact)).toEqual([
      '0.006',
      '0.004',
    ]);
    expect(result.cash_payments[0].paid_at).toBe('2026-09-09T12:34:56.123456Z');
  });
  it('keeps different captured payers from mixing fractional cents even in the same funding pool', () => {
    const result = read({
      pending_amount: '0.00',
      paid_amount: '0.00',
      closed_entitlement_exact: '0.012',
      consumed_exact: '0',
      unpaid_exact: '0.012',
      balances: [unpaid(), unpaid('0.006', '0.00', { scope: scope({ payer_user_id: PAYER2 }) })],
      cash_payments: [],
    });
    expect(parse(result).pending_amount).toBe('0.00');
    result.pending_amount = '0.01';
    expect(() => parse(result)).toThrow();
  });
  it('preserves valid liability before bank admission creates a funding pool', () => {
    const result = fractionRead();
    result.balances[0].pool_id = null;
    expect(parse(result).balances[0].unpaid_exact).toBe('0.006');
  });
  it('excludes an open UTC week from closed cash while retaining its exact earnings', () => {
    const result = fractionRead();
    result.balances[0].earning_weeks.push({
      week_start: '2026-09-07',
      week_end: '2026-09-13',
      closed: false,
      entitlement_exact: '88.0075',
      consumed_exact: '0',
      remaining_exact: '88.0075',
      source_count: 1,
      funding_admitted_source_count: 0,
    });
    expect(parse(result).closed_entitlement_exact).toBe('0.006');
  });
  it('formats large whole-cent strings without binary rounding', () => {
    expect(formatRakebackCash('9007199254740993.01')).toBe('9,007,199,254,740,993.01');
    expect(formatRakebackCash('9007199254740993.01', 'de-DE')).toBe('9.007.199.254.740.993,01');
  });
  it.each([undefined, 'true', 1])('rejects an inexact activation witness %s', (value) => {
    const result = read();
    result.source_active = value as never;
    expect(() => parse(result)).toThrow();
  });
  const invalidReads: [string, (value: CapturedRakebackReadV2) => void][] = [
    [
      'v1 schema',
      (r) => {
        r.schema_version = 1 as never;
      },
    ],
    [
      'wrong beneficiary',
      (r) => {
        r.beneficiary_user_id = B;
      },
    ],
    [
      'numeric cash',
      (r) => {
        r.pending_amount = 2.99 as never;
      },
    ],
    [
      'fractional cash',
      (r) => {
        r.pending_amount = '0.006';
      },
    ],
    [
      'whitespace cash',
      (r) => {
        r.pending_amount = ' 2.99';
      },
    ],
    [
      'hex cash',
      (r) => {
        r.pending_amount = '0x10';
      },
    ],
    [
      'exponent cash',
      (r) => {
        r.pending_amount = '1e2';
      },
    ],
    [
      'noncanonical exact',
      (r) => {
        r.closed_entitlement_exact = '10.0';
      },
    ],
    [
      'negative exact',
      (r) => {
        r.unpaid_exact = '-2.99';
      },
    ],
    [
      'duplicate scope',
      (r) => {
        r.balances.push(structuredClone(r.balances[0]));
      },
    ],
    [
      'duplicate earning week',
      (r) => {
        r.balances[0].earning_weeks.push(structuredClone(r.balances[0].earning_weeks[0]));
      },
    ],
    [
      'wrong week end',
      (r) => {
        r.balances[0].earning_weeks[0].week_end = '2026-09-07';
      },
    ],
    [
      'invalid calendar date',
      (r) => {
        r.balances[0].earning_weeks[0].week_start = '2026-02-30';
      },
    ],
    [
      'open week marked closed',
      (r) => {
        r.balances[0].earning_weeks[0].closed = false;
      },
    ],
    [
      'admitted count exceeds sources',
      (r) => {
        r.balances[0].earning_weeks[0].funding_admitted_source_count = 2;
      },
    ],
    [
      'weekly consumption differs from slices',
      (r) => {
        r.balances[0].earning_weeks[0].consumed_exact = '7';
        r.balances[0].earning_weeks[0].remaining_exact = '3';
      },
    ],
    [
      'scope pending differs from closed carry',
      (r) => {
        r.balances[0].pending_amount = '3.00';
      },
    ],
    [
      'top paid differs from receipts',
      (r) => {
        r.paid_amount = '7.02';
      },
    ],
    [
      'duplicate payment',
      (r) => {
        r.cash_payments.push(structuredClone(r.cash_payments[0]));
      },
    ],
    [
      'duplicate source slice',
      (r) => {
        r.cash_payments[0].earning_slices.push(
          structuredClone(r.cash_payments[0].earning_slices[0])
        );
      },
    ],
    [
      'wrong source beneficiary',
      (r) => {
        r.cash_payments[0].earning_slices[0].contributor_id = B;
      },
    ],
    [
      'future earning slice',
      (r) => {
        r.cash_payments[0].earning_slices[0].week_start = '2026-09-07';
      },
    ],
    [
      'payment slices do not sum',
      (r) => {
        r.cash_payments[0].earning_slices[0].amount_exact = '7';
      },
    ],
    [
      'non-UTC receipt',
      (r) => {
        r.cash_payments[0].paid_at = '2026-09-09T12:34:56.123456+01:00';
      },
    ],
    [
      'invalid payment date',
      (r) => {
        r.cash_payments[0].paid_at = '2026-02-30T12:34:56.123456Z';
      },
    ],
    [
      'payment cutoff later than read cutoff',
      (r) => {
        r.cash_payments[0].earning_closed_through = '2026-09-14';
      },
    ],
    [
      'missing pool after payment',
      (r) => {
        r.balances[0].pool_id = null;
      },
    ],
    [
      'payment pool differs from balance',
      (r) => {
        r.cash_payments[0].pool_id = CLUB2;
      },
    ],
    [
      'inactive source with balances',
      (r) => {
        r.source_active = false;
      },
    ],
    [
      'unresolved duplicate identity',
      (r) => {
        const item = {
          club_id: CLUB,
          week_start: '2026-08-31',
          week_end: '2026-09-06',
          source_count: 1,
          reasons: ['unresolved'],
        };
        r.unresolved_earnings = [item, item];
      },
    ],
  ];
  it.each(invalidReads)('refuses %s', (label, mutate) => {
    const result = read();
    mutate(result);
    expect(() => parse(result)).toThrow();
  });
  const invalidClaims: [string, (value: CapturedRakebackClaimV2) => void][] = [
    [
      'v1 schema',
      (r) => {
        r.schema_version = 1 as never;
      },
    ],
    [
      'wrong request',
      (r) => {
        r.request_id = A;
      },
    ],
    [
      'wrong beneficiary',
      (r) => {
        r.beneficiary_user_id = B;
      },
    ],
    [
      'changed immutable club scope',
      (r) => {
        r.club_id = CLUB2;
      },
    ],
    [
      'incorrect payout total',
      (r) => {
        r.new_payout = '9.99';
      },
    ],
    [
      'incorrect payment count',
      (r) => {
        r.payment_count = 2;
      },
    ],
    [
      'duplicate payment',
      (r) => {
        r.payments.push(r.payments[0]);
      },
    ],
    [
      'missing partition',
      (r) => {
        r.scopes[0].payment_ids = [];
        r.scopes[0].new_payout = '0.00';
      },
    ],
    [
      'duplicated partition',
      (r) => {
        r.scopes[0].payment_ids.push(r.scopes[0].payment_ids[0]);
      },
    ],
    [
      'partition pays another scope',
      (r) => {
        r.scopes[0].scope = scope({ payer_user_id: PAYER2 });
      },
    ],
    [
      'fractional new cash',
      (r) => {
        r.new_payout = '0.006';
      },
    ],
    [
      'empty deferral reason',
      (r) => {
        r.scopes[0].deferred = [{ reason: '' }];
      },
    ],
  ];
  it.each(invalidClaims)('keeps the durable UUID when claim has %s', async (label, mutate) => {
    observeRakebackActivation(A, true);
    const request = prepareRakebackRequest(A);
    const value = claimResult(request.requestId);
    mutate(value);
    mocks.rpc.mockResolvedValue({ data: value, error: null });
    await expect(claimCapturedRakeback(request)).rejects.toThrow();
    expect(readRakebackRequests(A)).toEqual([request]);
  });
  it('accepts an authoritative partial payout with only its new receipt and explicit remaining deferral', () => {
    const result = claimResult(B, '0.01');
    result.scopes[0].deferred = [{ reason: 'source_wallet_unavailable_or_short' }];
    expect(parseCapturedRakebackClaim(result, savedRequest).new_payout).toBe('0.01');
  });
  it('accepts zero paid with deferred funding and no invented payment receipt', () => {
    const result = claimResult(B, '0.00');
    result.scopes[0].pool_id = null;
    result.scopes[0].deferred = [{ reason: 'funding_pool_not_admitted' }];
    expect(parseCapturedRakebackClaim(result, savedRequest).payment_count).toBe(0);
  });
});

describe('Rendered Captured Rakeback V2 Recovery', () => {
  it('keeps exact weeks and cash payment dates separate, without rounding .006 into .01 weekly cash', async () => {
    mocks.rpc.mockResolvedValue(source(carryRead()));
    render(<RakebackPage />);
    await screen.findByRole('heading', { name: 'Cash Payment History' });
    expect(screen.getByLabelText('Closed Earnings')).toHaveTextContent('0.012');
    expect(screen.getByLabelText('Paid Chips')).toHaveTextContent('0.01');
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('0.00');
    expect(screen.getAllByText('Earned: 0.006')).toHaveLength(2);
    expect(screen.getByText('Allocated To Payments: 0.004')).toBeInTheDocument();
    expect(screen.getByText('Remaining Earnings: 0.002')).toBeInTheDocument();
    expect(document.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-09-09T12:34:56.123456Z'
    );
    expect(screen.getByRole('heading', { name: 'Previous Rakeback History' })).toBeInTheDocument();
    expect(screen.getAllByText('999.00').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Claim Rakeback' })).not.toBeInTheDocument();
  });
  it('shows exact .0075 prebank liability and unresolved records without cash-ready promises', async () => {
    const value = fractionRead();
    value.closed_entitlement_exact = '0.0075';
    value.unpaid_exact = '0.0075';
    value.balances = [unpaid('0.0075', '0.00', { pool_id: null })];
    value.unresolved_earnings = [
      {
        club_id: CLUB2,
        week_start: '2026-08-31',
        week_end: '2026-09-06',
        source_count: 2,
        reasons: ['unresolved_assignment'],
      },
    ];
    mocks.rpc.mockResolvedValue(source(value));
    render(<RakebackPage />);
    await screen.findByText('Funding Not Yet Recorded.');
    expect(screen.getByText('Unpaid Earnings: 0.0075')).toBeInTheDocument();
    expect(screen.getByText('Fraction Carried Forward')).toBeInTheDocument();
    expect(screen.getByText('2 Earning Records Need Review')).toBeInTheDocument();
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('0.00');
  });
  it('uses all-club scope and reconciled new receipts without adding legacy estimates', async () => {
    const secondScope = scope({ club_id: CLUB2 });
    const value = read({
      pending_amount: '3.99',
      closed_entitlement_exact: '11',
      unpaid_exact: '3.99',
      balances: [balance(), unpaid('1', '1.00', { scope: secondScope, pool_id: CLUB2 })],
    });
    mocks.rpc.mockImplementation((name, args) => {
      if (name === 'fn_get_captured_rakeback') return Promise.resolve(source(value));
      const result = claimResult(args.p_request_id, '3.99');
      result.payments = [
        payment('2.99', { payment_id: PAYMENT2 }),
        payment('1.00', {
          payment_id: PAYER2,
          scope: secondScope,
          pool_id: CLUB2,
          earning_slices: [
            { hand_id: HAND2, contributor_id: A, week_start: '2026-08-31', amount_exact: '1' },
          ],
        }),
      ];
      result.payment_count = 2;
      result.scopes = [
        {
          scope: scope(),
          pool_id: POOL,
          new_payout: '2.99',
          payment_ids: [PAYMENT2],
          deferred: [],
        },
        {
          scope: secondScope,
          pool_id: CLUB2,
          new_payout: '1.00',
          payment_ids: [PAYER2],
          deferred: [],
        },
      ];
      return Promise.resolve({ data: result, error: null });
    });
    render(<RakebackPage />);
    await ready();
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('3.99');
    expect(screen.getByLabelText('Closed Earnings')).toHaveTextContent('11');
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText('Claimed 3.99 Chips.');
    expect(mutations()).toEqual([
      [
        'fn_claim_captured_rakeback',
        { p_request_id: expect.any(String), p_expected_user_id: A, p_club_id: null },
      ],
    ]);
    expect(readRakebackRequests(A)).toEqual([]);
  });
  it('recovers the identical persisted UUID after lost response and refresh with zero pending', async () => {
    let id = '',
      lost = true;
    mocks.rpc.mockImplementation((name, args) => {
      if (name === 'fn_get_captured_rakeback')
        return Promise.resolve(source(id ? paidRead() : read()));
      id = args.p_request_id;
      return lost ? Promise.reject(new TypeError('Lost Response')) : Promise.resolve(receipt(id));
    });
    const first = render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText(
      'Claim Not Yet Confirmed. Use Recover Claim To Check The Same Request.'
    );
    expect(readRakebackRequests(A)[0].requestId).toBe(id);
    first.unmount();
    lost = false;
    render(<RakebackPage />);
    const recover = await screen.findByRole('button', { name: 'Recover Claim' });
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('0.00');
    fireEvent.click(recover);
    await screen.findByText('Claimed 2.99 Chips.');
    expect(mutations().map(([, args]) => args.p_request_id)).toEqual([id, id]);
    expect(readRakebackRequests(A)).toEqual([]);
  });
  it('recovers while capability is unavailable using the original saved scope', async () => {
    observeRakebackActivation(A, true);
    const saved = { version: 1 as const, expectedUserId: A, requestId: B, clubId: CLUB2 };
    localStorage.setItem('ca:captured-rakeback:v1:' + A + ':request:' + B, JSON.stringify(saved));
    mocks.rpc.mockImplementation((name) => {
      if (name === 'fn_get_captured_rakeback')
        return Promise.resolve({ data: null, error: { message: 'Unavailable' } });
      const result = claimResult(B, '0.00', { club_id: CLUB2 });
      result.scopes = [
        {
          scope: scope({ club_id: CLUB2 }),
          pool_id: null,
          new_payout: '0.00',
          payment_ids: [],
          deferred: [],
        },
      ];
      return Promise.resolve({ data: result, error: null });
    });
    render(<RakebackPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recover Claim' }));
    await screen.findByText('Claim Verified. No Additional Chips Were Paid.');
    expect(mutations()).toEqual([
      ['fn_claim_captured_rakeback', { p_request_id: B, p_expected_user_id: A, p_club_id: CLUB2 }],
    ]);
    expect(readRakebackRequests(A)).toEqual([]);
  });
  it.each(['error', 'mismatch', 'malformed', 'v1'])(
    'retains recovery after %s response',
    async (mode) => {
      mocks.rpc.mockImplementation((name, args) => {
        if (name === 'fn_get_captured_rakeback') return Promise.resolve(source());
        if (mode === 'error') return Promise.resolve({ data: null, error: { code: 'NETWORK' } });
        const result = claimResult(mode === 'mismatch' ? B : args.p_request_id);
        if (mode === 'malformed') result.new_payout = 'NaN';
        if (mode === 'v1') result.schema_version = 1 as never;
        return Promise.resolve({ data: result, error: null });
      });
      render(<RakebackPage />);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
      await screen.findByText(
        'Claim Not Yet Confirmed. Use Recover Claim To Check The Same Request.'
      );
      expect(readRakebackRequests(A)).toHaveLength(1);
      expect(mocks.emit).not.toHaveBeenCalled();
    }
  );
  it('fails closed when capability is missing, preserving previous history', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    render(<RakebackPage />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Claim Rakeback' })).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
    expect(screen.getAllByText('999.00').length).toBeGreaterThan(0);
  });
  it('uses legacy only after exact inactive reads and never retries its cutover refusal', async () => {
    mocks.legacy.mockResolvedValue({
      data: [
        {
          id: 'legacy-pending',
          club_id: CLUB,
          period_start: '2026-08-31',
          period_end: '2026-09-06',
          rake_generated: 100,
          rakeback_rate: 0.1,
          rakeback_earned: 10,
          status: 'pending',
        },
      ],
      error: null,
    });
    let active = false;
    mocks.rpc.mockImplementation((name) => {
      if (name === 'fn_get_captured_rakeback')
        return Promise.resolve(source(active ? read() : inactive()));
      active = true;
      return Promise.resolve({ data: null, error: { code: '55000' } });
    });
    render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText(
      'Rakeback Claiming Has Changed. Review The Refreshed Balance And Claim Again.'
    );
    await waitFor(() => expect(screen.getByLabelText('Closed Earnings')).toHaveTextContent('10'));
    expect(mutations()).toEqual([['fn_claim_rakeback', { p_club_id: CLUB }]]);
  });
  it('refuses an inactive capability after sticky activation', async () => {
    const first = render(<RakebackPage />);
    await ready();
    first.unmount();
    mocks.rpc.mockResolvedValue(source(inactive()));
    render(<RakebackPage />);
    await screen.findByRole('alert');
    expect(mutations()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Claim Rakeback' })).not.toBeInTheDocument();
  });
  it('suppresses stale account load completion and clears the preceding account view', async () => {
    const old = deferred<ReturnType<typeof source>>();
    mocks.rpc
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(() => Promise.resolve(source(fractionRead())));
    const view = render(<RakebackPage />);
    mocks.userId = B;
    view.rerender(<RakebackPage />);
    await screen.findByText('Fraction Carried Forward');
    await act(async () => old.resolve(source(read(), A)));
    expect(screen.getByLabelText('Closed Earnings')).toHaveTextContent('0.006');
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('0.00');
  });
  it('suppresses stale account payout completion and keeps its UUID for its owner', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    mocks.rpc.mockImplementation((name) =>
      name === 'fn_get_captured_rakeback' ? Promise.resolve(source()) : pending.promise
    );
    const view = render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await waitFor(() => expect(readRakebackRequests(A)).toHaveLength(1));
    const saved = readRakebackRequests(A)[0];
    mocks.userId = B;
    view.rerender(<RakebackPage />);
    await ready();
    await act(async () => pending.resolve(receipt(saved.requestId)));
    expect(screen.queryByText('Claimed 2.99 Chips.')).not.toBeInTheDocument();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(readRakebackRequests(A)).toEqual([saved]);
    expect(readRakebackRequests(B)).toEqual([]);
  });
  it('retains recovery after A to B to A before an old payout completes', async () => {
    const old = deferred<ReturnType<typeof receipt>>();
    mocks.rpc.mockImplementation((name) =>
      name === 'fn_get_captured_rakeback' ? Promise.resolve(source()) : old.promise
    );
    const view = render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await waitFor(() => expect(readRakebackRequests(A)).toHaveLength(1));
    const saved = readRakebackRequests(A)[0];
    mocks.userId = B;
    view.rerender(<RakebackPage />);
    mocks.userId = A;
    view.rerender(<RakebackPage />);
    await screen.findByRole('button', { name: 'Recover Claim' });
    await act(async () => old.resolve(receipt(saved.requestId)));
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(readRakebackRequests(A)).toEqual([saved]);
  });
  it('deduplicates rapid clicks while one request is unresolved', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    mocks.rpc.mockImplementation((name) =>
      name === 'fn_get_captured_rakeback' ? Promise.resolve(source()) : pending.promise
    );
    render(<RakebackPage />);
    await ready();
    const button = screen.getByRole('button', { name: 'Claim Rakeback' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mutations()).toHaveLength(1));
    await act(async () => pending.resolve(receipt(readRakebackRequests(A)[0].requestId)));
  });
  it('distinguishes a confirmed transfer from local receipt cleanup failure', async () => {
    render(<RakebackPage />);
    await ready();
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('Storage Unavailable');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText(
      'Claim Confirmed. This Browser Could Not Clear Its Saved Receipt. Recover Claim Safely Checks That Confirmation.'
    );
    expect(readRakebackRequests(A)).toHaveLength(1);
    expect(mocks.emit).toHaveBeenCalledWith('RAKEBACK_CLAIMED', {
      clubId: '',
      amount: 2.99,
      userId: A,
    });
  });
  it('shows a partial payment and explicit unpaid remainder', async () => {
    mocks.rpc.mockImplementation((name, args) => {
      if (name === 'fn_get_captured_rakeback') return Promise.resolve(source());
      const value = claimResult(args.p_request_id, '0.01');
      value.scopes[0].deferred = [{ reason: 'source_wallet_unavailable_or_short' }];
      return Promise.resolve({ data: value, error: null });
    });
    render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText('Claimed 0.01 Chips. Some Rakeback Remains Unpaid.');
    expect(readRakebackRequests(A)).toEqual([]);
  });
  it('shows a zero-paid deferral as still unpaid and permits a later new UUID', async () => {
    mocks.rpc.mockImplementation((name, args) => {
      if (name === 'fn_get_captured_rakeback') return Promise.resolve(source());
      const value = claimResult(args.p_request_id, '0.00');
      value.scopes[0].deferred = [{ reason: 'source_wallet_unavailable_or_short' }];
      return Promise.resolve({ data: value, error: null });
    });
    render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText('Claim Checked. Rakeback Remains Unpaid. Please Check Again Later.');
    expect(readRakebackRequests(A)).toEqual([]);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await waitFor(() => expect(mutations()).toHaveLength(2));
    expect(mutations()[0][1].p_request_id).not.toBe(mutations()[1][1].p_request_id);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('rejects inactive source data before any legacy mutation', async () => {
    const value = read({ source_active: false });
    mocks.rpc.mockResolvedValue(source(value));
    render(<RakebackPage />);
    await screen.findByRole('alert');
    expect(mutations()).toEqual([]);
  });
});

describe('Versioned Durable Recovery Storage', () => {
  it('refuses mutation without a durably stored UUID', () => {
    observeRakebackActivation(A, true);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota');
    });
    expect(() => prepareRakebackRequest(A)).toThrow();
    expect(mutations()).toEqual([]);
  });
  it('preserves corrupt unresolved storage instead of replacing the UUID', () => {
    observeRakebackActivation(A, true);
    const key = 'ca:captured-rakeback:v1:' + A + ':request:' + B;
    localStorage.setItem(key, '{broken');
    expect(() => prepareRakebackRequest(A)).toThrow();
    expect(localStorage.getItem(key)).toBe('{broken');
  });
  it('tolerates another tab clearing a confirmed key after enumeration', () => {
    observeRakebackActivation(A, true);
    const request = prepareRakebackRequest(A),
      original = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key.endsWith('request:' + request.requestId) ? null : original(key)
    );
    expect(readRakebackRequests(A)).toEqual([]);
  });
});

describe('Native SQL Responses And Immutable Source Identity', () => {
  it('parses and renders the actual bank-to-player cross-week payment response', async () => {
    mocks.userId = nativeCrossWeek.beneficiary_user_id;
    expect(parseCapturedRakeback(nativeCrossWeek, mocks.userId)).toEqual(nativeCrossWeek);
    mocks.rpc.mockResolvedValue({ data: nativeCrossWeek, error: null });
    render(<RakebackPage />);
    await screen.findByRole('heading', { name: 'Cash Payment History' });
    expect(screen.getByLabelText('Closed Earnings')).toHaveTextContent('0.018');
    expect(screen.getByLabelText('Paid Chips')).toHaveTextContent('0.01');
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('0.00');
    expect(screen.getAllByText('Earned: 0.009')).toHaveLength(2);
    expect(screen.getByText('Allocated To Payments: 0.001')).toBeInTheDocument();
    expect(screen.getByText('Remaining Earnings: 0.008')).toBeInTheDocument();
    expect(document.querySelector('time')?.getAttribute('dateTime')).toBe(
      nativeCrossWeek.cash_payments[0].paid_at
    );
  });
  it('parses and renders the actual prebank unpaid earning without inventing a pool', async () => {
    mocks.userId = nativePrebank.beneficiary_user_id;
    expect(parseCapturedRakeback(nativePrebank, mocks.userId)).toEqual(nativePrebank);
    mocks.rpc.mockResolvedValue({ data: nativePrebank, error: null });
    render(<RakebackPage />);
    await screen.findByText('Funding Not Yet Recorded.');
    expect(screen.getByText('Unpaid Earnings: 0.009')).toBeInTheDocument();
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('0.00');
  });
  it('rejects contradictory pool presence for different payers in one original funding agreement', () => {
    const result = read({
      pending_amount: '0.00',
      paid_amount: '0.00',
      closed_entitlement_exact: '0.012',
      consumed_exact: '0',
      unpaid_exact: '0.012',
      balances: [
        unpaid(),
        unpaid('0.006', '0.00', { scope: scope({ payer_user_id: PAYER2 }), pool_id: null }),
      ],
      cash_payments: [],
    });
    expect(() => parse(result)).toThrow();
  });
  it('rejects a self-payer balance and receipt', () => {
    const result = read();
    result.balances[0].scope.payer_user_id = A;
    result.cash_payments[0].scope.payer_user_id = A;
    expect(() => parse(result)).toThrow();
  });
  it('allows multiple partial payments from one immutable source but rejects its earning-week retag', () => {
    const result = claimResult(B, '0.02', {
      payment_count: 2,
      payments: [
        payment('0.01', { payment_id: PAYMENT }),
        payment('0.01', { payment_id: PAYMENT2 }),
      ],
      scopes: [
        {
          scope: scope(),
          pool_id: POOL,
          new_payout: '0.02',
          payment_ids: [PAYMENT, PAYMENT2],
          deferred: [],
        },
      ],
    });
    expect(parseCapturedRakebackClaim(result, savedRequest).payment_count).toBe(2);
    result.payments[1].earning_slices[0].week_start = '2026-08-24';
    expect(() => parseCapturedRakebackClaim(result, savedRequest)).toThrow();
  });
  it('rejects the same immutable source being retagged to another payer across payments', () => {
    const result = claimResult(B, '0.02', {
      payment_count: 2,
      payments: [
        payment('0.01', { payment_id: PAYMENT }),
        payment('0.01', { payment_id: PAYMENT2, scope: scope({ payer_user_id: PAYER2 }) }),
      ],
      scopes: [
        { scope: scope(), pool_id: POOL, new_payout: '0.01', payment_ids: [PAYMENT], deferred: [] },
        {
          scope: scope({ payer_user_id: PAYER2 }),
          pool_id: POOL,
          new_payout: '0.01',
          payment_ids: [PAYMENT2],
          deferred: [],
        },
      ],
    });
    expect(() => parseCapturedRakebackClaim(result, savedRequest)).toThrow();
  });
  it('only emits numeric refresh hints when whole cents survive a round trip', () => {
    expect(cashRefreshAmount('2.99')).toBe(2.99);
    expect(cashRefreshAmount('9007199254740993.01')).toBeUndefined();
    for (let cents = 9007199254740980n; cents <= 9007199254740991n; cents++) {
      const amount = (cents / 100n).toString() + '.' + (cents % 100n).toString().padStart(2, '0');
      const numeric = cashRefreshAmount(amount);
      if (numeric !== undefined) expect(BigInt(numeric.toFixed(2).replace('.', ''))).toBe(cents);
    }
  });
  it('distinguishes original Union and standalone funding agreements for one club and payer', async () => {
    const unionScope = scope({ funding_union_id: CLUB2, funding_route: 'union_rake_wallet' });
    const value = read({
      pending_amount: '0.00',
      paid_amount: '0.00',
      closed_entitlement_exact: '0.012',
      consumed_exact: '0',
      unpaid_exact: '0.012',
      balances: [unpaid(), unpaid('0.006', '0.00', { scope: unionScope, pool_id: null })],
      cash_payments: [],
    });
    mocks.rpc.mockResolvedValue(source(value));
    render(<RakebackPage />);
    await screen.findByText('Original Union dddddddd');
    expect(screen.getByText('Club Funding')).toBeInTheDocument();
  });
});

describe('Actual Native V2 Claim Witness', () => {
  const request = {
    version: 1 as const,
    requestId: nativeClaim.request_id,
    expectedUserId: nativeClaim.beneficiary_user_id,
    clubId: nativeClaim.club_id,
  };
  it('reconciles the real multi-scope claim and its single new cash receipt', () => {
    expect(parseCapturedRakebackClaim(nativeClaim, request)).toEqual(nativeClaim);
    expect(nativeClaim.scopes).toHaveLength(4);
    expect(nativeClaim.payment_count).toBe(1);
    expect(nativeClaim.new_payout).toBe('0.01');
    expect(nativeClaim.scopes.flatMap((scope) => scope.payment_ids)).toEqual([
      nativeClaim.payments[0].payment_id,
    ]);
  });
  it('recovers the stored UUID through the actual service and page using the native receipt', async () => {
    mocks.userId = request.expectedUserId;
    localStorage.setItem(
      'ca:captured-rakeback:v1:' + request.expectedUserId + ':request:' + request.requestId,
      JSON.stringify(request)
    );
    mocks.rpc.mockImplementation((name) =>
      name === 'fn_get_captured_rakeback'
        ? Promise.resolve({ data: null, error: { message: 'Availability Unavailable' } })
        : Promise.resolve({ data: nativeClaim, error: null })
    );
    render(<RakebackPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recover Claim' }));
    await screen.findByText('Claimed 0.01 Chips. Some Rakeback Remains Unpaid.');
    expect(mutations()).toEqual([
      [
        'fn_claim_captured_rakeback',
        {
          p_request_id: request.requestId,
          p_expected_user_id: request.expectedUserId,
          p_club_id: request.clubId,
        },
      ],
    ]);
    expect(readRakebackRequests(request.expectedUserId)).toEqual([]);
    expect(mocks.emit).toHaveBeenCalledWith('RAKEBACK_CLAIMED', {
      clubId: '',
      amount: 0.01,
      userId: request.expectedUserId,
    });
  });
});
