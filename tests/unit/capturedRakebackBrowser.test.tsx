import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import RakebackPage from '../../src/pages/RakebackPage';
import {
  claimCapturedRakeback,
  observeRakebackActivation,
  parseCapturedRakeback,
  prepareRakebackRequest,
  readRakebackRequests,
} from '../../src/services/CapturedRakebackService';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CLUB = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CLUB2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
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

function period(overrides: Record<string, unknown> = {}) {
  return {
    club_id: CLUB,
    period_start: '2026-08-31',
    period_end: '2026-09-06',
    rake_generated: 100,
    rakeback_rate: 0.1,
    rakeback_earned: 10,
    paid_amount: 7.01,
    pending_amount: 2.99,
    exact_entitlement: 10,
    unpaid_exact_entitlement: 2.99,
    unresolved_sources: 0,
    status: 'pending',
    ...overrides,
  };
}
function source(periods = [period()], source_active = true) {
  return { data: { source_active, source_final: false, periods }, error: null };
}
function receipt(requestId: string, total = 2.99) {
  return {
    data: {
      success: true,
      request_id: requestId,
      source_final: false,
      total_payout: total,
      periods_claimed: total > 0 ? 1 : 0,
      periods: [
        {
          success: true,
          period_id: CLUB,
          new_payout: total,
          source_accruals_added: 0,
          paid_receipts: [],
          deferred: [],
          source_final: false,
        },
      ],
    },
    error: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
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

describe('Captured Rakeback Browser Contract', () => {
  it('uses remaining cents across all clubs and keeps overlapping legacy history out of source totals', async () => {
    mocks.rpc.mockImplementation((name, args) =>
      name === 'fn_get_captured_rakeback'
        ? Promise.resolve(
            source([period(), period({ club_id: CLUB2, pending_amount: 1, paid_amount: 9 })])
          )
        : Promise.resolve(receipt(args.p_request_id, 3.99))
    );
    render(<RakebackPage />);
    await ready();
    expect(screen.getByLabelText(/^(Unpaid Rakeback|Ready To Claim)$/)).toHaveTextContent('3.99');
    expect(screen.getByLabelText('Captured Earnings')).toHaveTextContent('20.00');
    expect(screen.getByRole('heading', { name: 'Previous Rakeback History' })).toBeInTheDocument();
    expect(screen.getAllByText('999.00').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText('Claimed 3.99 Chips.');
    expect(mutations()).toEqual([
      [
        'fn_claim_captured_rakeback',
        {
          p_request_id: expect.any(String),
          p_expected_user_id: A,
          p_club_id: null,
        },
      ],
    ]);
    expect(readRakebackRequests(A)).toEqual([]);
  });

  it('shows unpaid fractions without rounding them into claimable cents', async () => {
    mocks.rpc.mockResolvedValue(
      source([
        period({
          rakeback_earned: 0,
          pending_amount: 0,
          paid_amount: 0,
          exact_entitlement: 0.006,
          unpaid_exact_entitlement: 0.006,
          status: 'fraction_pending',
        }),
      ])
    );
    render(<RakebackPage />);
    await screen.findByText('Fraction Carried Forward');
    expect(screen.getByLabelText(/^(Unpaid Rakeback|Ready To Claim)$/)).toHaveTextContent('0.00');
    expect(screen.getByText('Unpaid Earnings: 0.006')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Claim Rakeback/ })).not.toBeInTheDocument();
  });

  it('recovers the identical persisted request after a lost response and refresh even when pending is zero', async () => {
    let requestId = '';
    let lost = true;
    mocks.rpc.mockImplementation((name, args) => {
      if (name === 'fn_get_captured_rakeback')
        return Promise.resolve(
          source([
            period({
              pending_amount: requestId ? 0 : 2.99,
            }),
          ])
        );
      requestId = args.p_request_id;
      return lost
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(receipt(requestId));
    });
    const first = render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText(
      'Claim Not Yet Confirmed. Use Recover Claim To Check The Same Request.'
    );
    expect(readRakebackRequests(A)[0].requestId).toBe(requestId);
    first.unmount();
    lost = false;
    render(<RakebackPage />);
    const recover = await screen.findByRole('button', { name: 'Recover Claim' });
    expect(screen.getByLabelText(/^(Unpaid Rakeback|Ready To Claim)$/)).toHaveTextContent('0.00');
    fireEvent.click(recover);
    await screen.findByText('Claimed 2.99 Chips.');
    expect(mutations().map(([, args]) => args.p_request_id)).toEqual([requestId, requestId]);
    expect(readRakebackRequests(A)).toEqual([]);
  });

  it.each([
    [
      'transport error response',
      { data: null, error: { code: 'NETWORK', message: 'Connection Lost' } },
    ],
    ['mismatched receipt', receipt(B)],
    ['malformed amount', { ...receipt(A), data: { ...receipt(A).data, total_payout: 'NaN' } }],
  ])('retains recovery after %s', async (_label, response) => {
    mocks.rpc.mockImplementation((name, args) =>
      name === 'fn_get_captured_rakeback'
        ? Promise.resolve(source())
        : Promise.resolve(
            _label === 'malformed amount'
              ? { ...response, data: { ...response.data, request_id: args.p_request_id } }
              : response
          )
    );
    render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText(
      'Claim Not Yet Confirmed. Use Recover Claim To Check The Same Request.'
    );
    expect(readRakebackRequests(A)).toHaveLength(1);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('can recover a saved request while the availability read is unavailable', async () => {
    observeRakebackActivation(A, true);
    const saved = prepareRakebackRequest(A);
    mocks.rpc.mockImplementation((name) =>
      name === 'fn_get_captured_rakeback'
        ? Promise.resolve({ data: null, error: { message: 'Unavailable' } })
        : Promise.resolve(receipt(saved.requestId, 0))
    );
    render(<RakebackPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recover Claim' }));
    await screen.findByText('Claim Verified. No Additional Chips Were Paid.');
    expect(readRakebackRequests(A)).toEqual([]);
    expect(mutations()).toHaveLength(1);
  });

  it.each([undefined, 'true', 1])('rejects an inexact activation witness %s', (value) => {
    expect(() => parseCapturedRakeback({ ...source().data, source_active: value })).toThrow();
  });

  it('does not fall back to a legacy mutation when source capability fails', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Function Missing' },
    });
    render(<RakebackPage />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Claim Rakeback' })).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
    expect(screen.getAllByText('999.00').length).toBeGreaterThan(0);
  });

  it('uses the legacy path only after exact inactive reads and never retries a cutover refusal', async () => {
    mocks.legacy.mockResolvedValue({
      data: [{ ...period(), id: 'old-pending', status: 'pending' }],
      error: null,
    });
    let active = false;
    mocks.rpc.mockImplementation((name) => {
      if (name === 'fn_get_captured_rakeback')
        return Promise.resolve(source(active ? [period()] : [], active));
      active = true;
      return Promise.resolve({
        data: null,
        error: { code: '55000', message: 'captured_claim_request_required' },
      });
    });
    render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText(
      'Rakeback Claiming Has Changed. Review The Refreshed Balance And Claim Again.'
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Captured Earnings')).toHaveTextContent('10.00')
    );
    expect(mutations()).toEqual([['fn_claim_rakeback', { p_club_id: CLUB }]]);
  });

  it('persists the activated mode and refuses a later inactive response after refresh', async () => {
    const first = render(<RakebackPage />);
    await ready();
    first.unmount();
    mocks.rpc.mockResolvedValue(source([], false));
    render(<RakebackPage />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Claim Rakeback' })).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });

  it('suppresses stale account load completions and erases the old account view immediately', async () => {
    const oldRead = deferred<ReturnType<typeof source>>();
    mocks.rpc
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementation(() =>
        Promise.resolve(source([period({ rakeback_earned: 42, pending_amount: 4 })]))
      );
    const view = render(<RakebackPage />);
    mocks.userId = B;
    view.rerender(<RakebackPage />);
    await ready();
    await act(async () =>
      oldRead.resolve(source([period({ rakeback_earned: 777, pending_amount: 77 })]))
    );
    expect(screen.getByLabelText('Captured Earnings')).toHaveTextContent('42.00');
    expect(screen.getByLabelText(/^(Unpaid Rakeback|Ready To Claim)$/)).toHaveTextContent('4.00');
  });

  it('suppresses stale account claim completion and preserves its receipt for that account', async () => {
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
    expect(screen.queryByText(/Previous Claim Is Awaiting/)).not.toBeInTheDocument();
    await ready();
    await act(async () => pending.resolve(receipt(saved.requestId)));
    expect(screen.queryByText('Claimed 2.99 Chips.')).not.toBeInTheDocument();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(readRakebackRequests(A)[0]).toEqual(saved);
    expect(readRakebackRequests(B)).toEqual([]);
  });

  it('deduplicates rapid clicks while a single request is unresolved', async () => {
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
    const saved = readRakebackRequests(A)[0];
    await act(async () => pending.resolve(receipt(saved.requestId)));
  });

  it('does not send a mutation unless the recovery request is durably stored', async () => {
    observeRakebackActivation(A, true);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota Exceeded');
    });
    expect(() => prepareRakebackRequest(A)).toThrow();
    expect(mutations()).toEqual([]);
  });

  it('does not overwrite or drop a corrupt unresolved request', () => {
    observeRakebackActivation(A, true);
    const key = 'ca:captured-rakeback:v1:' + A + ':request:' + B;
    localStorage.setItem(key, '{broken');
    expect(() => prepareRakebackRequest(A)).toThrow();
    expect(localStorage.getItem(key)).toBe('{broken');
  });

  it('replays the stored immutable club scope rather than selecting a new club', async () => {
    observeRakebackActivation(A, true);
    const saved = { version: 1 as const, expectedUserId: A, requestId: B, clubId: CLUB2 };
    localStorage.setItem('ca:captured-rakeback:v1:' + A + ':request:' + B, JSON.stringify(saved));
    const chosen = prepareRakebackRequest(A);
    await claimCapturedRakeback(chosen);
    expect(mutations()[0]).toEqual([
      'fn_claim_captured_rakeback',
      {
        p_request_id: B,
        p_expected_user_id: A,
        p_club_id: CLUB2,
      },
    ]);
  });
  it.each([
    0.006,
    ' ',
    '0x10',
    '1e2',
    '0.010000000000000002',
    0.010000000000000002,
    Number.MAX_SAFE_INTEGER,
  ])('rejects noncash pending amount %s', (pending_amount) => {
    expect(() => parseCapturedRakeback(source([period({ pending_amount })]).data)).toThrow();
  });

  it('rejects duplicate club weeks and dates that drift outside the UTC week', () => {
    expect(() => parseCapturedRakeback(source([period(), period()]).data)).toThrow();
    expect(() =>
      parseCapturedRakeback(source([period({ period_end: '2026-09-07' })]).data)
    ).toThrow();
    expect(() =>
      parseCapturedRakeback(source([period({ period_start: '2026-02-30' })]).data)
    ).toThrow();
  });

  it('skips a request that another tab removed after enumerating storage', () => {
    observeRakebackActivation(A, true);
    const request = prepareRakebackRequest(A);
    const original = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key.endsWith('request:' + request.requestId) ? null : original(key)
    );
    expect(readRakebackRequests(A)).toEqual([]);
  });

  it.each(['total', 'count', 'duplicate', 'fraction', 'identity'])(
    'keeps the request when period receipt %s does not reconcile',
    async (invalid) => {
      observeRakebackActivation(A, true);
      const request = prepareRakebackRequest(A);
      const result = receipt(request.requestId);
      if (invalid === 'total') result.data.total_payout = 99;
      if (invalid === 'count') result.data.periods_claimed = 2;
      if (invalid === 'duplicate') result.data.periods.push(result.data.periods[0]);
      if (invalid === 'fraction') result.data.periods[0].new_payout = 0.006;
      if (invalid === 'identity') result.data.periods[0].period_id = 'missing';
      mocks.rpc.mockResolvedValue(result);
      await expect(claimCapturedRakeback(request)).rejects.toThrow();
      expect(readRakebackRequests(A)).toEqual([request]);
    }
  );

  it('distinguishes a confirmed payout from failure to clear its local receipt', async () => {
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

  it('rejects inactive capability with captured periods instead of choosing a legacy claim', async () => {
    mocks.rpc.mockResolvedValue(source([period({ pending_amount: 88 })], false));
    expect(() => parseCapturedRakeback(source([period()], false).data)).toThrow();
    render(<RakebackPage />);
    await screen.findByRole('alert');
    expect(mutations()).toEqual([]);
    await waitFor(() =>
      expect(screen.getByLabelText('Recorded Earnings')).toHaveTextContent('999.00')
    );
    expect(screen.getByLabelText(/^(Unpaid Rakeback|Ready To Claim)$/)).toHaveTextContent('0.00');
  });

  it('shows an authoritative zero-paid deferral as still unpaid and permits a later new claim', async () => {
    mocks.rpc.mockImplementation((name, args) => {
      if (name === 'fn_get_captured_rakeback') return Promise.resolve(source());
      const result = receipt(args.p_request_id, 0);
      result.data.periods[0].success = false;
      (result.data.periods[0].deferred as unknown[]) = [
        { reason: 'source_wallet_unavailable_or_short' },
      ];
      return Promise.resolve(result);
    });
    render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await screen.findByText('Claim Checked. Rakeback Remains Unpaid. Please Check Again Later.');
    expect(readRakebackRequests(A)).toEqual([]);
    expect(screen.getByLabelText('Unpaid Rakeback')).toHaveTextContent('2.99');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('recovers after switching away and back before the old claim completes', async () => {
    const oldClaim = deferred<ReturnType<typeof receipt>>();
    const otherRead = deferred<ReturnType<typeof source>>();
    mocks.rpc.mockImplementation((name) => {
      if (name === 'fn_get_captured_rakeback') {
        return mocks.userId === B ? otherRead.promise : Promise.resolve(source());
      }
      return oldClaim.promise;
    });
    const view = render(<RakebackPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    await waitFor(() => expect(readRakebackRequests(A)).toHaveLength(1));
    const saved = readRakebackRequests(A)[0];
    mocks.userId = B;
    view.rerender(<RakebackPage />);
    mocks.userId = A;
    view.rerender(<RakebackPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Recover Claim' })).toBeEnabled()
    );
    await act(async () => {
      oldClaim.resolve(receipt(saved.requestId));
      otherRead.resolve(source());
    });
    expect(screen.queryByText('Claimed 2.99 Chips.')).not.toBeInTheDocument();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(readRakebackRequests(A)).toEqual([saved]);
  });
});
