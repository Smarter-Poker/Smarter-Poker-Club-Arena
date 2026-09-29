import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../src/lib/supabase';
import CashierStatementsPage from '../src/pages/CashierStatementsPage';

/**
 * CASHIER PHASE 5: the Full Statement page.
 *
 * The page is member-reachable, so what it shows is decided by
 * fn_cashier_statement_page alone. These tests mock supabase.rpc by NAME with
 * the contract's JSON shapes and read what a person would read.
 */

const CLUB = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: USER }, isHydrating: false }),
}));
vi.mock('../src/services/CashoutService', () => ({
  captureCashoutAccountGuard: () => () => true,
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const rpc = vi.mocked(supabase.rpc);
const ok = (data: unknown) => Promise.resolve({ data, error: null } as never);
const NEVER = new Promise<never>(() => {});

const ROWS = [
  {
    source: 'receipt',
    id: 'bbbbbbbb-0001-4000-8000-000000000001',
    at: '2026-09-20T11:56:00Z',
    kind: 'agent_wallet_send',
    wallet: 'agent',
    direction: 'out',
    amount: '2500.00',
    from: { type: 'agent_wallet', id: USER, label: 'kingfish' },
    to: { type: 'player_wallet', id: 'aaaaaaaa-0006-4000-8000-000000000006', label: 'donk bettor' },
    counterparty: 'donk bettor',
    notes: 'cashier send out',
    state: 'reversible',
    reference: {
      id: 'bbbbbbbb-0001-4000-8000-000000000001',
      source: 'receipt',
      op_id: '0f0e0d0c-1111-4222-8333-444455556666',
      idempotency_key: 'agent-send-0f0e0d0c',
      correlation_id: null,
      ledger_id: null,
      cashout_id: null,
      ticket_id: null,
    },
    balance_after: '9999.50',
    table_id: null,
    tournament_id: null,
    hand_id: null,
  },
  {
    source: 'movement',
    id: 'cccccccc-0002-4000-8000-000000000002',
    at: '2026-09-20T09:00:00Z',
    kind: 'tournament_prize',
    wallet: 'player',
    direction: 'in',
    amount: '1234567.00',
    from: { type: 'prize_liability', id: null, label: null },
    to: { type: 'player_wallet', id: USER, label: 'kingfish' },
    counterparty: null,
    notes: null,
    state: 'posted',
    reference: {
      id: 'cccccccc-0002-4000-8000-000000000002',
      source: 'movement',
      op_id: null,
      idempotency_key: null,
      correlation_id: null,
      ledger_id: 'cccccccc-0002-4000-8000-000000000002',
      cashout_id: null,
      ticket_id: null,
    },
    balance_after: '510000.58',
    table_id: null,
    tournament_id: 'dddddddd-0003-4000-8000-000000000003',
    hand_id: null,
  },
];

const PAGE = {
  authorized: true,
  scope: 'downline',
  viewer: USER,
  range: { from: '2026-09-14T07:00:00Z', to: '2026-09-21T07:00:00Z' },
  filters: {},
  rows: ROWS,
  next_cursor: { at: ROWS[1].at, source: 'movement', id: ROWS[1].id, fp: 'fp' },
  generated_at: '2026-09-20T12:00:00Z',
};

/** The totals door: whole filtered range, server-side. */
const TOTALS = {
  authorized: true,
  scope: 'downline',
  range: PAGE.range,
  filters: {},
  totals: { in: '1234567.00', out: '2500.00', managed: '0.00', count: 1432 },
  generated_at: '2026-09-20T12:00:00Z',
};
const ZERO_TOTALS = { ...TOTALS, totals: { in: '0.00', out: '0.00', managed: '0.00', count: 0 } };
const byName = (name: string) =>
  name === 'fn_cashier_statement_page'
    ? ok(PAGE)
    : name === 'fn_cashier_statement_totals'
      ? ok(TOTALS)
      : ok(null);

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB}/cashier/statements`]}>
      <Routes>
        <Route path="/clubs/:clubId/cashier/statements" element={<CashierStatementsPage />} />
        <Route path="*" element={<Location />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Every word a person reads, minus references (printed exactly as stored). */
function visibleWords(root: HTMLElement): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const ref of clone.querySelectorAll('[data-reference]')) ref.remove();
  return (clone.textContent || '')
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''))
    .filter((w) => w && !/\d/.test(w));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('CashierStatementsPage', () => {
  it('prints the statement in Title Case with exact figures and the server totals', async () => {
    rpc.mockImplementation(byName as never);
    const { container } = renderPage();

    expect(await screen.findByText('Your Entries And Your Downline')).toBeInTheDocument();
    expect(screen.getByText('To Donk Bettor')).toBeInTheDocument();
    expect(screen.getByText('From Prize Liability')).toBeInTheDocument();
    // Each figure prints once on its row and once in the server's totals.
    expect(screen.getAllByText('-2,500')).toHaveLength(2);
    expect(screen.getAllByText('+1,234,567')).toHaveLength(2);
    const totals = screen.getByLabelText('Statement Totals');
    expect(await within(totals).findByText('+1,234,567')).toBeInTheDocument();
    expect(within(totals).getByText('1,432')).toBeInTheDocument();
    expect(screen.getByText('Load More')).toBeInTheDocument();
    expect(screen.getByText('Ref BBBBBBBB')).toBeInTheDocument();

    // The receipt prints the full reference set, exactly as stored.
    fireEvent.click(screen.getByText('To Donk Bettor'));
    expect(screen.getByText('agent-send-0f0e0d0c')).toBeInTheDocument();
    expect(screen.getByText('0f0e0d0c-1111-4222-8333-444455556666')).toBeInTheDocument();
    expect(screen.getByText('Cashier Send Out')).toBeInTheDocument();
    // A receipt never prints a balance, even if one arrives; a movement does.
    expect(screen.queryByText('Balance After')).not.toBeInTheDocument();
    expect(screen.queryByText('9,999.50')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('From Prize Liability'));
    expect(screen.getByText('Balance After')).toBeInTheDocument();
    expect(screen.getByText('510,000.58')).toBeInTheDocument();

    const lower = visibleWords(container).filter((w) => /^[a-z]/.test(w));
    expect(lower).toEqual([]);
    expect(container.textContent).not.toMatch(/horse/i);
  });

  it('shows the refusal state and no figures when the server says authorized:false', async () => {
    rpc.mockImplementation((() => ok({ authorized: false, reason: 'not_member' })) as never);
    renderPage();
    expect(await screen.findByText('Statement Unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Statement Totals')).not.toBeInTheDocument();
    expect(screen.getByText('Check Again')).toBeInTheDocument();
  });

  it('treats an RPC 42501 as a refusal, never as an empty statement', async () => {
    rpc.mockImplementation((() =>
      Promise.resolve({
        data: null,
        error: { code: '42501', message: 'denied' },
      } as never)) as never);
    renderPage();
    expect(await screen.findByText('Statement Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No Entries In This Range.')).not.toBeInTheDocument();
  });

  it('a failed read is an error with Retry and dashes, never an empty list or a zero', async () => {
    rpc.mockImplementation((() =>
      Promise.resolve({
        data: null,
        error: { code: 'PGRST500', message: 'x' },
      } as never)) as never);
    renderPage();
    expect(await screen.findByText('Retry')).toBeInTheDocument();
    expect(screen.queryByText('No Entries In This Range.')).not.toBeInTheDocument();
    const totals = screen.getByLabelText('Statement Totals');
    expect(within(totals).queryByText('0')).not.toBeInTheDocument();
    expect(within(totals).getAllByText('-')).toHaveLength(4);
  });

  it('an empty range says so', async () => {
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals'
        ? ok(ZERO_TOTALS)
        : ok({ ...PAGE, rows: [], next_cursor: null })) as never);
    renderPage();
    expect(await screen.findByText('No Entries In This Range.')).toBeInTheDocument();
    expect(screen.getByText('Export CSV')).toBeDisabled();
  });

  it('says Calculating while the totals door is in flight, then prints the figures', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((done) => {
      finish = done;
    });
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals' ? pending : ok(PAGE)) as never);
    renderPage();
    await screen.findByText('To Donk Bettor');
    const totals = screen.getByLabelText('Statement Totals');
    expect(within(totals).getByText('Calculating')).toBeInTheDocument();
    expect(within(totals).queryByText('0')).not.toBeInTheDocument();
    await act(async () => {
      finish({ data: TOTALS, error: null });
    });
    expect(
      within(screen.getByLabelText('Statement Totals')).getByText('1,432')
    ).toBeInTheDocument();
  });

  it('a totals timeout (57014) is Unavailable For This Range, never zero, and the rows stay', async () => {
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals'
        ? Promise.resolve({
            data: null,
            error: { code: '57014', message: 'canceling statement due to statement timeout' },
          } as never)
        : ok(PAGE)) as never);
    renderPage();
    const totals = await screen.findByLabelText('Statement Totals');
    expect(await within(totals).findByText('Unavailable For This Range')).toBeInTheDocument();
    expect(within(totals).queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('To Donk Bettor')).toBeInTheDocument();
  });

  it('authorized:false from the totals door clears the statement', async () => {
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals'
        ? ok({ authorized: false, reason: 'role' })
        : ok(PAGE)) as never);
    renderPage();
    expect(await screen.findByText('Statement Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('To Donk Bettor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Statement Totals')).not.toBeInTheDocument();
  });

  it('prints ledger account types in Title Case, never raw', async () => {
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals'
        ? ok(TOTALS)
        : ok({
            ...PAGE,
            rows: [
              {
                ...ROWS[1],
                direction: 'managed',
                from: { type: 'club_treasury', id: null, label: null },
                to: { type: 'settlement_suspense', id: null, label: null },
              },
            ],
          })) as never);
    const { container } = renderPage();
    expect(
      await screen.findByText('Transfer Club Treasury To Settlement Suspense')
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/club_treasury|settlement_suspense/);
  });

  it('shows loading while the statement is read', () => {
    rpc.mockImplementation((() => NEVER) as never);
    renderPage();
    expect(screen.getByText('Loading Statement...')).toBeInTheDocument();
  });

  it('walks the export states: ready, then expired with Prepare Again', async () => {
    rpc.mockImplementation(((name: string) => {
      if (name === 'fn_cashier_statement_page') return ok(PAGE);
      if (name === 'fn_cashier_statement_export_start')
        return ok({
          export_id: 'eeeeeeee-0000-4000-8000-000000000001',
          total_rows: 1432,
          expires_at: '2026-09-20T12:15:00Z',
          totals: TOTALS.totals,
          metadata_fingerprint: 'abc',
        });
      if (name === 'fn_cashier_statement_export_page')
        return Promise.resolve({
          data: null,
          error: { code: '55000', message: 'export expired; prepare a new export' },
        } as never);
      return ok(true);
    }) as never);
    renderPage();
    await screen.findByText('To Donk Bettor');
    fireEvent.click(screen.getByText('Export CSV'));
    expect(await screen.findByText(/1,432 Entries Ready\. Expires At/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Download CSV'));
    expect(await screen.findByText('Prepare Again')).toBeInTheDocument();
    expect(screen.getByText('This Export Expired. Prepare It Again.')).toBeInTheDocument();
  });

  it('refuses a reversed custom range before asking the server', async () => {
    rpc.mockImplementation((() => ok(PAGE)) as never);
    renderPage();
    await screen.findByText('Your Entries And Your Downline');
    fireEvent.click(screen.getByText('Custom'));
    fireEvent.change(screen.getByLabelText('Statement Start Date'), {
      target: { value: '2026-09-20' },
    });
    fireEvent.change(screen.getByLabelText('Statement End Date'), {
      target: { value: '2026-09-01' },
    });
    const before = rpc.mock.calls.length;
    fireEvent.click(screen.getByText('Show Range'));
    expect(screen.getByText('The Start Date Must Come Before The End Date.')).toBeInTheDocument();
    expect(rpc.mock.calls.length).toBe(before);
  });

  it('applies filters as one request and says when nothing matches', async () => {
    rpc.mockImplementation(((_: string, args: Record<string, unknown>) =>
      Object.keys((args.p_filters as object) || {}).length
        ? ok({ ...PAGE, rows: [], next_cursor: null })
        : ok(PAGE)) as never);
    renderPage();
    await screen.findByText('To Donk Bettor');
    fireEvent.click(screen.getByText('Show Filters'));
    fireEvent.click(within(screen.getByLabelText('Filter By Wallet')).getByText('Promo'));
    fireEvent.change(screen.getByLabelText('Filter By Exact Reference'), {
      target: { value: 'agent-send-0f0e0d0c' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Apply Filters'));
    });
    expect(await screen.findByText('No Entries Match These Filters.')).toBeInTheDocument();
    const last = rpc.mock.calls[rpc.mock.calls.length - 1][1] as Record<string, unknown>;
    expect(last.p_filters).toEqual({ wallet: 'promo', reference: 'agent-send-0f0e0d0c' });
  });

  it('goes back to the Trade Cashier', async () => {
    rpc.mockImplementation((() => ok(PAGE)) as never);
    renderPage();
    fireEvent.click((await screen.findAllByText('Back To Cashier'))[0]);
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/clubs/${CLUB}/cashier`)
    );
  });
});

describe('route registration and the Trade Record link', () => {
  it('registers the lazy route behind the same guards as the Cashier', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toContain(
      "const CashierStatementsPage = lazyWithRetry(() => import('./pages/CashierStatementsPage'));"
    );
    expect(app).toMatch(
      /path="clubs\/:clubId\/cashier\/statements"\s*element=\{\s*<AuthGuard>\s*<ClubMemberGuard>\s*<PageErrorBoundary pageName="Cashier">\s*<CashierStatementsPage \/>/
    );
  });

  it('links the Trade Record tab to the Full Statement', () => {
    const trade = readFileSync('src/pages/CashierTradePage.tsx', 'utf8');
    expect(trade).toContain('navigate(`/clubs/${clubParam}/cashier/statements`)');
    expect(trade.match(/>\s*Full Statement\s*</g)).toHaveLength(1);
  });

  it('calls only the contract RPCs, never a table, and never .single()', () => {
    const sources = [
      readFileSync('src/pages/CashierStatementsPage.tsx', 'utf8'),
      readFileSync('src/hooks/useCashierStatement.ts', 'utf8'),
    ].join('\n');
    const rpcs = [...sources.matchAll(/supabase\.rpc\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(rpcs)).toEqual(
      new Set([
        'fn_cashier_statement_page',
        'fn_cashier_statement_totals',
        'fn_cashier_statement_export_start',
        'fn_cashier_statement_export_page',
        'fn_cashier_statement_export_cancel',
      ])
    );
    expect(sources).not.toContain('supabase.from(');
    expect(sources).not.toContain('.single()');
    expect(sources).not.toMatch(/is_horse|isHorse/);
  });
});
