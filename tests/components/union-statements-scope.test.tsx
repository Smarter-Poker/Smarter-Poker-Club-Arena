import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  route: { unionId: 'union-a', unionRef: 'union-a' },
  actorId: 'operator-a',
  rpc: vi.fn(),
  getSession: vi.fn(),
  fetch: vi.fn(),
  navigate: vi.fn(),
  downloadCsv: vi.fn(),
  reportError: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => testState.navigate,
}));

vi.mock('../../src/hooks/useUnionRouteId', () => ({
  useUnionRouteId: () => testState.route,
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: testState.actorId }, isHydrating: false }),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => testState.toast,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => testState.rpc(...args),
    auth: { getSession: (...args: unknown[]) => testState.getSession(...args) },
  },
}));

vi.mock('../../src/utils/downloadCsv', () => ({
  csvEscape: (value: unknown) => String(value ?? ''),
  downloadCsv: (...args: unknown[]) => testState.downloadCsv(...args),
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => testState.reportError(...args),
}));

function ConsoleMock({
  title,
  children,
  plates,
}: {
  title: string;
  children?: ReactNode;
  plates?: {
    secondary?: { label: string; disabled?: boolean; onClick?: () => void };
    primary?: { label: string; disabled?: boolean; onClick?: () => void };
  };
}) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
      {plates?.secondary && (
        <button
          type="button"
          disabled={plates.secondary.disabled}
          onClick={plates.secondary.onClick}
        >
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button type="button" disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      )}
    </section>
  );
}

vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ConsoleMock,
}));

vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: ConsoleMock,
}));

vi.mock('../../src/components/agent/UnionAccountingRunStatus', () => ({
  default: ({ unionId }: { unionId: string }) => <div>Accounting {unionId}</div>,
}));

import UnionStatementsPage from '../../src/pages/UnionStatementsPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function statementBoard(
  unionId: string,
  unionName: string,
  clubName: string,
  invoiceId = `${unionId}-invoice`
) {
  return {
    union_id: unionId,
    union_name: unionName,
    period_start: '2026-09-07',
    period_end: '2026-09-14',
    totals: {
      clubs: 1,
      issued: 1,
      missing: 0,
      delivered: 1,
      paid: 0,
      clubs_owe: 120.25,
      union_owes: 0,
      net: 120.25,
      collected: 0,
      outstanding: 120.25,
      rake_generated: 200,
      eco_amount: 0,
    },
    clubs: [
      {
        club_id: `${unionId}-club`,
        club_name: clubName,
        club_code: null,
        club_slug: null,
        invoice_id: invoiceId,
        snapshot_complete: true,
        status: 'generated',
        issued_at: '2026-09-14T09:00:00Z',
        due_at: '2026-09-21T09:00:00Z',
        amount: 120.25,
        direction: 'club owes union',
        message_sent: true,
        overdue: false,
        paid_total: 0,
        outstanding: 120.25,
        rake_generated: 200,
        rakeback_due: 180,
        union_fee_kept: 20,
        players_won: 0,
        eco_amount: 0,
        presettled: 0,
      },
    ],
    history: [],
    generated_at: '2026-10-03T12:00:00Z',
  };
}

function insurance(unionId = testState.route.unionId) {
  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date('2026-09-20T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + index);
    return {
      d: date.toISOString().slice(0, 10),
      contracts: 0,
      premiums: 0,
      payouts: 0,
      net: 0,
      overlay: 0,
    };
  });
  return {
    data: {
      union_id: unionId,
      range_days: 14,
      totals: { contracts: 0, premiums: 0, payouts: 0, net: 0 },
      overlay: { events: 0, funded: 0 },
      daily,
      by_club: [],
      generated_at: '2026-10-03T12:00:00.000Z',
    },
    error: null,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  testState.route.unionId = 'union-a';
  testState.route.unionRef = 'union-a';
  testState.actorId = 'operator-a';
  testState.rpc.mockReset();
  testState.getSession.mockReset().mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
    error: null,
  });
  testState.fetch.mockReset();
  testState.navigate.mockReset();
  testState.downloadCsv.mockReset();
  testState.reportError.mockReset();
  for (const fn of Object.values(testState.toast)) fn.mockReset();
  vi.stubGlobal('fetch', (...args: unknown[]) => testState.fetch(...args));
});

describe('Union Statements request identity', () => {
  it('ignores a delayed board from the previous union route', async () => {
    const alpha = deferred<{ data: ReturnType<typeof statementBoard>; error: null }>();
    const beta = deferred<{ data: ReturnType<typeof statementBoard>; error: null }>();
    testState.rpc.mockImplementation((name: string, args: { p_union_id?: string }) => {
      if (name === 'ca_union_insurance_pnl') return Promise.resolve(insurance());
      return args.p_union_id === 'union-a' ? alpha.promise : beta.promise;
    });

    const view = render(<UnionStatementsPage />);
    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith(
        'ca_union_statement_board',
        expect.objectContaining({ p_union_id: 'union-a' })
      )
    );

    testState.route.unionId = 'union-b';
    testState.route.unionRef = 'union-b';
    view.rerender(<UnionStatementsPage />);
    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith(
        'ca_union_statement_board',
        expect.objectContaining({ p_union_id: 'union-b' })
      )
    );

    await act(async () =>
      beta.resolve({ data: statementBoard('union-b', 'beta union', 'beta club'), error: null })
    );
    expect(await screen.findByText('Beta Union')).toBeVisible();
    expect(screen.getByText('Beta Club')).toBeVisible();

    await act(async () =>
      alpha.resolve({ data: statementBoard('union-a', 'alpha union', 'alpha club'), error: null })
    );
    expect(screen.queryByText('Alpha Union')).toBeNull();
    expect(screen.queryByText('Alpha Club')).toBeNull();
    expect(screen.getByText('Beta Club')).toBeVisible();
  });

  it('renders only a fully reconciled insurance payload', async () => {
    testState.rpc.mockImplementation((name: string, args: { p_union_id?: string }) => {
      if (name === 'ca_union_insurance_pnl') {
        const response = insurance(args.p_union_id);
        response.data.totals.net = 1;
        return Promise.resolve(response);
      }
      return Promise.resolve({
        data: statementBoard('union-a', 'alpha union', 'alpha club'),
        error: null,
      });
    });

    render(<UnionStatementsPage />);

    expect(await screen.findByText('Alpha Club')).toBeVisible();
    await waitFor(() =>
      expect(testState.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'UnionStatementsPage.insurance_shape',
        { unionId: 'union-a' }
      )
    );
    expect(screen.queryByLabelText('Insurance Profit And Loss')).toBeNull();
  });

  it('does not reuse the prior actor board on an account change', async () => {
    const firstActor = deferred<{ data: ReturnType<typeof statementBoard>; error: null }>();
    testState.rpc
      .mockImplementationOnce(() => Promise.resolve(insurance()))
      .mockImplementationOnce(() => firstActor.promise)
      .mockImplementationOnce(() => Promise.resolve(insurance()))
      .mockImplementationOnce(() =>
        Promise.resolve({
          data: statementBoard('union-a', 'second actor union', 'second actor club'),
          error: null,
        })
      );

    const view = render(<UnionStatementsPage />);
    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith('ca_union_statement_board', expect.anything())
    );
    testState.actorId = 'operator-b';
    view.rerender(<UnionStatementsPage />);

    expect(await screen.findByText('Second Actor Club')).toBeVisible();
    await act(async () =>
      firstActor.resolve({
        data: statementBoard('union-a', 'first actor union', 'first actor club'),
        error: null,
      })
    );
    expect(screen.queryByText('First Actor Club')).toBeNull();
    expect(screen.getByText('Second Actor Club')).toBeVisible();
  });

  it('does not deliver a completed old-route issue action into the new union', async () => {
    const initialBoard = deferred<{ data: ReturnType<typeof statementBoard>; error: null }>();
    const issueResponse = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    testState.rpc.mockImplementation((name: string, args: { p_union_id?: string }) => {
      if (name === 'ca_union_insurance_pnl') return Promise.resolve(insurance());
      if (args.p_union_id === 'union-a') return initialBoard.promise;
      return Promise.resolve({
        data: statementBoard('union-b', 'beta union', 'beta club'),
        error: null,
      });
    });
    testState.fetch.mockReturnValue(issueResponse.promise);

    const view = render(<UnionStatementsPage />);
    const pendingIssue = screen.getByRole('button', {
      name: 'Issue Statements For The Closed Week',
    });
    expect(pendingIssue).toBeDisabled();
    fireEvent.click(pendingIssue);
    expect(screen.queryByRole('button', { name: 'Yes, Issue And Deliver' })).toBeNull();
    expect(testState.fetch).not.toHaveBeenCalled();
    await act(async () =>
      initialBoard.resolve({
        data: statementBoard('union-a', 'alpha union', 'alpha club'),
        error: null,
      })
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Issue Statements For The Closed Week' })
      ).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Issue Statements For The Closed Week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Issue And Deliver' }));
    await waitFor(() => expect(testState.fetch).toHaveBeenCalledTimes(1));

    testState.route.unionId = 'union-b';
    testState.route.unionRef = 'union-b';
    view.rerender(<UnionStatementsPage />);
    expect(await screen.findByText('Beta Club')).toBeVisible();

    await act(async () =>
      issueResponse.resolve({ ok: true, json: async () => ({ success: true, issued: 1 }) })
    );
    expect(testState.toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Beta Club')).toBeVisible();
  });

  it.each([
    ['an empty object', {}],
    ['a string success flag', { success: 'true', issued: 1 }],
    ['a string issued count', { success: true, issued: '1' }],
    ['a negative issued count', { success: true, issued: -1 }],
    ['conflicting issued counts', { success: true, issued: 1, invoices: 2 }],
    ['another union receipt', { success: true, issued: 1, union_id: 'union-b' }],
    ['another period receipt', { success: true, issued: 1, period_end: '2026-09-21' }],
  ])('refuses %s as a successful statement-delivery receipt', async (_label, payload) => {
    testState.rpc.mockImplementation((name: string) => {
      if (name === 'ca_union_insurance_pnl') return Promise.resolve(insurance());
      return Promise.resolve({
        data: statementBoard('union-a', 'alpha union', 'alpha club'),
        error: null,
      });
    });
    testState.fetch.mockResolvedValue({ ok: true, json: async () => payload });

    render(<UnionStatementsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Issue Statements For The Closed Week' })
      ).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Issue Statements For The Closed Week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Issue And Deliver' }));

    await waitFor(() =>
      expect(testState.toast.error).toHaveBeenCalledWith(
        'Statement Delivery Receipt Could Not Be Verified. Review The Board.'
      )
    );
    expect(testState.toast.success).not.toHaveBeenCalled();
    expect(testState.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'UnionStatementsPage.issue_receipt',
      { unionId: 'union-a', periodEnd: '2026-09-14' }
    );
  });

  it('accepts a literal, scope-bound statement-delivery receipt', async () => {
    testState.rpc.mockImplementation((name: string) => {
      if (name === 'ca_union_insurance_pnl') return Promise.resolve(insurance());
      return Promise.resolve({
        data: statementBoard('union-a', 'alpha union', 'alpha club'),
        error: null,
      });
    });
    testState.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        issued: 1,
        union_id: 'union-a',
        period_end: '2026-09-14',
      }),
    });

    render(<UnionStatementsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Issue Statements For The Closed Week' })
      ).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Issue Statements For The Closed Week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Issue And Deliver' }));

    await waitFor(() =>
      expect(testState.toast.success).toHaveBeenCalledWith('Issued And Delivered 1 Statements')
    );
    expect(testState.toast.error).not.toHaveBeenCalled();
  });

  it('uses the maintained presettlement RPC and refuses a mismatched success receipt', async () => {
    testState.rpc.mockImplementation((name: string) => {
      if (name === 'ca_union_insurance_pnl') return Promise.resolve(insurance());
      if (name === 'fn_union_record_presettlement') {
        return Promise.resolve({
          data: {
            success: true,
            presettlement_id: '1d243df4-a97b-4d21-840a-890c5ccdc162',
            amount: 15.26,
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: statementBoard('union-a', 'alpha union', 'alpha club'),
        error: null,
      });
    });

    render(<UnionStatementsPage />);
    const clubName = await screen.findByText('Alpha Club');
    fireEvent.click(clubName.closest('button') as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: 'Record A Payment' }));
    fireEvent.change(screen.getByLabelText('Payment Received From Alpha Club'), {
      target: { value: '15.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith('fn_union_record_presettlement', {
        p_union_id: 'union-a',
        p_club_id: 'union-a-club',
        p_amount: 15.25,
        p_method: null,
        p_reference: null,
        p_note: 'Recorded on the statement board',
        p_operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      })
    );
    await waitFor(() =>
      expect(testState.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'UnionStatementsPage.presettlement_receipt',
        { unionId: 'union-a', clubId: 'union-a-club' }
      )
    );
    expect(testState.toast.success).not.toHaveBeenCalled();
    expect(testState.toast.error).toHaveBeenCalledWith(
      'Payment Receipt Could Not Be Verified. Retry To Check The Same Payment.'
    );
  });

  it('keeps mark-paid amount null and refuses a receipt for another invoice', async () => {
    testState.rpc.mockImplementation((name: string) => {
      if (name === 'ca_union_insurance_pnl') return Promise.resolve(insurance());
      if (name === 'ca_union_set_statement_paid') {
        return Promise.resolve({
          data: {
            success: true,
            invoice_id: 'another-invoice',
            status: 'paid',
            paid_total: 120.25,
            owed: 120.25,
            fully_settled: true,
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: statementBoard('union-a', 'alpha union', 'alpha club'),
        error: null,
      });
    });

    render(<UnionStatementsPage />);
    const clubName = await screen.findByText('Alpha Club');
    fireEvent.click(clubName.closest('button') as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Paid' }));

    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith('ca_union_set_statement_paid', {
        p_invoice_id: 'union-a-invoice',
        p_paid: true,
        p_amount: null,
        p_note: null,
      })
    );
    await waitFor(() =>
      expect(testState.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'UnionStatementsPage.set_paid_receipt',
        { invoiceId: 'union-a-invoice', paid: true }
      )
    );
    expect(testState.toast.success).not.toHaveBeenCalled();
    expect(testState.toast.error).toHaveBeenCalledWith(
      'Statement Receipt Could Not Be Verified. Review The Refreshed Board.'
    );
  });
});

describe('Union Statements painted-console contract', () => {
  const source = readFileSync('src/pages/UnionStatementsPage.tsx', 'utf8');
  const css = readFileSync('src/pages/UnionStatementsPage.module.css', 'utf8');

  it('keeps every page state and action on approved, intentional console families', () => {
    expect(source).toContain('RewardsSurfaceHeader');
    expect(source).toMatch(/<CasinoSurfaceHeader[\s\S]*?crest="flat"[\s\S]*?family="riveted"/);
    expect(source).toContain("label: 'Back'");
    expect(source).toContain("label: 'Export CSV'");

    const consoles = source.match(/<SpadeConsole\b[\s\S]*?>/g) ?? [];
    expect(consoles).toHaveLength(4);
    for (const consoleOpening of consoles) {
      expect(consoleOpening).toMatch(/family="(?:spade|shark|riveted)"/);
      expect(consoleOpening).toMatch(/crest="(?:spade|flat)"/);
      expect(consoleOpening).not.toMatch(/crest="(?:club|diamond)"/);
    }
  });

  it('uses engraved glass rows without CSS-drawn frames or generic effects', () => {
    expect(css).not.toMatch(/border-radius\s*:/);
    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/);
    expect(css).not.toMatch(/:hover\b/);
    expect(css).toContain('border-top: 1px solid #000');
    expect(css).toContain('box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%)');
  });

  it('binds reads and every mutation to route, account, period, and mount identity', () => {
    expect(source).toContain("user?.id ?? 'signed-out'");
    expect(source).toContain('unionRef');
    expect(source).toContain('scopeIdentity');
    expect(source).toContain('activeRouteRef.current === requestRoute');
    expect(source).toContain('activeScopeRef.current === requestScope');
    expect(source).toContain('useIsMounted');
    expect(source.match(/const actionScope = scopeIdentity/g)).toHaveLength(3);
    expect(source.match(/if \(!isCurrent\(\)\) return;/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('title-cases every dynamic name and status at its print site', () => {
    expect(source).toContain('titleCase(board.union_name)');
    expect(source).toContain('titleCase(c.club_name)');
    expect(source).toContain('titleCase(c.status)');
  });

  it.each(['transport', 'malformed'] as const)(
    'recovers the same payment after a %s response and remount instead of adding another credit',
    async (response) => {
      let calls = 0;
      const payments: Record<string, unknown>[] = [];
      testState.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
        if (name === 'ca_union_insurance_pnl') return Promise.resolve(insurance());
        if (name === 'fn_union_record_presettlement') {
          payments.push(args);
          calls++;
          if (calls === 1)
            return Promise.resolve(
              response === 'transport'
                ? { data: null, error: { message: 'Response Lost' } }
                : {
                    data: {
                      success: true,
                      presettlement_id: '1d243df4-a97b-4d21-840a-890c5ccdc162',
                      amount: 999,
                    },
                    error: null,
                  }
            );
          return Promise.resolve({
            data: {
              success: true,
              presettlement_id: '1d243df4-a97b-4d21-840a-890c5ccdc162',
              amount: args.p_amount,
              operation_id: args.p_operation_id,
              union_id: args.p_union_id,
              club_id: args.p_club_id,
              duplicate: true,
              invoice_id: 'ab000000-0000-4000-8000-000000000002',
              received_at: '2026-10-09T02:00:00Z',
            },
            error: null,
          });
        }
        return Promise.resolve({
          data: statementBoard('union-a', 'alpha union', 'alpha club'),
          error: null,
        });
      });
      const openPayment = async () => {
        const club = await screen.findByText('Alpha Club');
        fireEvent.click(club.closest('button') as HTMLButtonElement);
        fireEvent.click(screen.getByRole('button', { name: 'Record A Payment' }));
      };
      const view = render(<UnionStatementsPage />);
      await openPayment();
      fireEvent.change(screen.getByLabelText('Payment Received From Alpha Club'), {
        target: { value: '15.25' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Record' }));
      await waitFor(() => expect(testState.toast.error).toHaveBeenCalled());
      expect(payments[0].p_operation_id).toMatch(/^[0-9a-f-]{36}$/i);
      view.unmount();
      render(<UnionStatementsPage />);
      await openPayment();
      expect(screen.getByLabelText('Payment Received From Alpha Club')).toHaveValue(15.25);
      expect(screen.getByLabelText('Payment Received From Alpha Club')).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Retry Payment Check' }));
      await waitFor(() => expect(testState.toast.success).toHaveBeenCalled());
      expect(payments).toHaveLength(2);
      expect(payments[1]).toEqual(payments[0]);
      const club = await screen.findByText('Alpha Club');
      fireEvent.click(club.closest('button') as HTMLButtonElement);
      fireEvent.click(screen.getByRole('button', { name: 'Record A Payment' }));
      expect(screen.getByLabelText('Payment Received From Alpha Club')).not.toBeDisabled();
    }
  );

  it('refuses amounts above the stored payment maximum before saving a request or calling the RPC', async () => {
    testState.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'ca_union_insurance_pnl'
          ? insurance()
          : { data: statementBoard('union-a', 'alpha union', 'alpha club'), error: null }
      )
    );
    render(<UnionStatementsPage />);
    const club = await screen.findByText('Alpha Club');
    fireEvent.click(club.closest('button') as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: 'Record A Payment' }));
    const amount = screen.getByLabelText('Payment Received From Alpha Club');
    fireEvent.change(amount, { target: { value: '10000000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() =>
      expect(testState.toast.error).toHaveBeenCalledWith(
        'Enter An Amount No Greater Than 9,999,999,999.99 Chips'
      )
    );
    expect(
      testState.rpc.mock.calls.some(([name]) => name === 'fn_union_record_presettlement')
    ).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(amount).toBeEnabled();
  });
});
