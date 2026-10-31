import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../src/lib/supabase';
import CashierTradePage from '../src/pages/CashierTradePage';
import { engineChannelClient } from '../src/services/EngineStateClient';

/**
 * A TREASURY-FUNDED SEAT READS EXACTLY LIKE A HUMAN CLUB BANK SEND ON THE
 * TRADE RECORD (cashier launch decision 2, binding; Dan: "NOTHING SHOULD EVER
 * REVEAL A HORSES IDENTITY"). Rendered on the redesigned Trade page: the
 * legacy kind printed "Horse Treasury Funding" as the row's label, and a third
 * party's view of a Club Bank send named the operator, so a send nobody
 * pressed ("A Member To ...") stood apart from every human one.
 */
const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const SEATED = '33333333-3333-4333-8333-333333333333';
const PERSON = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: OWNER_ID }, isHydrating: false }),
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => toastMocks }));
// This rendering fixture supplies its authority reads; keep the shared live
// channel outside the fixture, as in cashier-history-recovery.test.tsx.
vi.mock('../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));

function mockClub(rows: Array<Record<string, unknown>>) {
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    let columns = '';
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['eq', 'in', 'or', 'order', 'limit', 'range']) {
      builder[method] = vi.fn(chain);
    }
    builder.select = vi.fn((value: string) => {
      columns = value;
      return builder;
    });
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve(
        table === 'club_members'
          ? { data: { role: 'owner', chip_balance: 250 }, error: null }
          : table === 'agents'
            ? { data: { agent_wallet_balance: 500 }, error: null }
            : { data: null, error: null }
      )
    );
    builder.then = (resolve: (value: unknown) => unknown) => {
      const value =
        table === 'club_members' && columns.includes('clubs:club_id')
          ? {
              data: [
                {
                  club_id: CLUB_ID,
                  role: 'owner',
                  chip_balance: 250,
                  clubs: {
                    name: 'Ledger Club',
                    club_id: 101,
                    slug: 'ledger-club',
                    logo_url: null,
                    is_union: false,
                    owner_id: OWNER_ID,
                  },
                },
              ],
              error: null,
            }
          : { data: [], error: null, count: 0 };
      return Promise.resolve(value).then(resolve);
    };
    return builder as never;
  });
  vi.mocked(supabase.rpc).mockImplementation(
    (name: string) =>
      Promise.resolve(
        name === 'fn_cashier_history_feed' ? { data: rows, error: null } : { data: [], error: null }
      ) as never
  );
}

const horseRow = {
  id: '66666666-6666-4666-8666-666666666666',
  created_at: '2026-10-10T09:00:00Z',
  transaction_type: 'horse_treasury_funding',
  amount: 500,
  from_user_id: null,
  to_user_id: SEATED,
  notes: 'Horse seated + funded from club treasury',
  metadata: null,
  from_name: null,
  to_name: 'Midnight Run',
};
const humanRow = {
  id: '77777777-7777-4777-8777-777777777777',
  created_at: '2026-10-10T08:00:00Z',
  transaction_type: 'club_bank_send',
  amount: 500,
  from_user_id: ADMIN,
  to_user_id: PERSON,
  notes: 'Club Bank Send',
  metadata: { destination: 'player_wallet', actor_role: 'admin' },
  from_name: 'Desk Admin',
  to_name: 'Night Owl',
};

async function openRecord() {
  render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
      <Routes>
        <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getByText('Balances Synchronized')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
  fireEvent.click(screen.getByRole('tab', { name: 'Transaction History' }));
}

describe('the Trade record prints a treasury-funded seat as a Club Bank send', () => {
  afterEach(() => engineChannelClient.disconnect());
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('reads word for word like a human Club Bank send the viewer was not party to', async () => {
    mockClub([horseRow, humanRow]);
    await openRecord();
    expect(await screen.findByText('Transfer Club Bank To Midnight Run')).toBeInTheDocument();
    expect(screen.getByText('Transfer Club Bank To Night Owl')).toBeInTheDocument();
    // Both rows carry the same kind and route, and nothing names a horse or
    // the admin who pressed the human send.
    const subs = screen.getAllByText((_, el) =>
      Boolean(
        el?.textContent?.startsWith('Club Bank Send') &&
        el.textContent.includes('Club Bank To Player Wallet')
      )
    );
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toMatch(/horse/i);
    expect(document.body.textContent).not.toMatch(/Treasury Funding/);
    expect(document.body.textContent).not.toContain('Desk Admin');
  });

  it('submits a player search across all dates and renders every returned entry', async () => {
    mockClub([horseRow, humanRow]);
    await openRecord();
    fireEvent.click(screen.getByRole('button', { name: 'Outgoing', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Cash-Outs', exact: true }));
    const search = screen.getByRole('searchbox', { name: 'Search Transaction History' });
    fireEvent.change(search, { target: { value: '  Midnight  ' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => {
      const reads = vi
        .mocked(supabase.rpc)
        .mock.calls.filter(([name]) => name === 'fn_cashier_history_feed');
      expect(reads.at(-1)?.[1]).toMatchObject({
        p_search: 'Midnight',
        p_from: null,
        p_kind: 'all',
        p_person: null,
        p_scope: 'club',
      });
    });
    expect(screen.getByRole('button', { name: 'All Dates', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'All Transactions', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      await screen.findByRole('button', { name: /Chip Movement Club Bank To Midnight Run/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Chip Movement Club Bank To Night Owl/ })
    ).toBeInTheDocument();
    // Repeated Enter refreshes the same book, rather than doing nothing.
    const before = vi
      .mocked(supabase.rpc)
      .mock.calls.filter(([name]) => name === 'fn_cashier_history_feed').length;
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() =>
      expect(
        vi.mocked(supabase.rpc).mock.calls.filter(([name]) => name === 'fn_cashier_history_feed')
          .length
      ).toBeGreaterThan(before)
    );
  });

  it('opens a receipt whose sentence is the human send sentence', async () => {
    mockClub([horseRow, humanRow]);
    await openRecord();
    fireEvent.click(
      await screen.findByRole('button', { name: /Chip Movement Club Bank To Midnight Run/ })
    );
    expect(
      await screen.findByText("The Club Bank Sent 500 To Midnight Run's Player Wallet")
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/horse/i);
  });
  it('opens Today and All Transactions with chip movements only', async () => {
    mockClub([]);
    await openRecord();
    expect(screen.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'All Transactions', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Chip Movements', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByRole('button', { name: 'Managed', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Games', exact: true })).not.toBeInTheDocument();
    const feed = vi
      .mocked(supabase.rpc)
      .mock.calls.find(([name]) => name === 'fn_cashier_history_feed');
    expect(feed?.[1]).toMatchObject({ p_scope: 'club', p_kind: 'all', p_limit: 51 });
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(feed?.[1]?.p_from).toBe(midnight.toISOString());
  });
});
