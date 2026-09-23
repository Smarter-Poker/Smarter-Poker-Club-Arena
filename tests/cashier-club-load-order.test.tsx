import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../src/lib/supabase';
import CashierTradePage from '../src/pages/CashierTradePage';
import {
  CASHIER_REQUEST_RECOVERY_PREFIX,
  writeCashierTransferRecovery,
} from '../src/services/CashierResilience';

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function localStorageHasPrefix(prefix: string): boolean {
  for (let index = 0; index < localStorage.length; index++) {
    if (localStorage.key(index)?.startsWith(prefix)) return true;
  }
  return false;
}

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: USER_ID }, isHydrating: false }),
}));

vi.mock('../src/components/common/Toast', () => ({
  useToast: () => toastMocks,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('CashierTradePage club load ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('lists every club wallet plus canonical owned unions, never a non-owned union treasury', async () => {
    const OWNED_UNION_ID = '44444444-4444-4444-8444-444444444444';
    const OTHER_UNION_ID = '55555555-5555-4555-8555-555555555555';
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
        let value: unknown = { data: [], error: null, count: 0 };
        if (table === 'unions') {
          value = {
            data: [
              {
                id: OWNED_UNION_ID,
                slug: 'midway-union',
                name: 'Midway Union',
                owner_id: USER_ID,
                avatar_url: null,
                member_count: 3,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
              },
            ],
            error: null,
          };
        } else if (table === 'club_members' && columns.includes('clubs:club_id')) {
          value = {
            data: [
              {
                club_id: CLUB_ID,
                role: 'owner',
                chip_balance: 250,
                clubs: {
                  name: 'Phase One Club',
                  club_id: 101,
                  slug: 'phase-one',
                  logo_url: null,
                  is_union: false,
                  owner_id: USER_ID,
                },
              },
              {
                club_id: OTHER_UNION_ID,
                role: 'admin',
                chip_balance: 999,
                clubs: {
                  name: 'Somebody Else Union',
                  club_id: 202,
                  slug: 'somebody-else-union',
                  logo_url: null,
                  is_union: true,
                  owner_id: PLAYER_ID,
                },
              },
            ],
            error: null,
          };
        }
        return Promise.resolve(value).then(resolve);
      };
      return builder as never;
    });
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route
            path="/clubs/:clubId/cashier"
            element={
              <>
                <CashierTradePage />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Balances synchronized')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /open another club cashier/i }));
    expect(await screen.findByRole('option', { name: /Midway Union/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Phase One Club/i })).toBeInTheDocument();
    expect(screen.queryByText('Somebody Else Union')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: /Midway Union/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/unions/midway-union/operations?tab=wallet'
      )
    );
  });

  it('renders and retries an owned-union directory failure instead of publishing a partial list', async () => {
    const OWNED_UNION_ID = '44444444-4444-4444-8444-444444444444';
    let unionAttempts = 0;
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
        let value: unknown = { data: [], error: null, count: 0 };
        if (table === 'unions') {
          unionAttempts += 1;
          value =
            unionAttempts === 1
              ? { data: null, error: new Error('union directory unavailable') }
              : {
                  data: [
                    {
                      id: OWNED_UNION_ID,
                      slug: 'recovered-union',
                      name: 'Recovered Union',
                      owner_id: USER_ID,
                      avatar_url: null,
                      member_count: 3,
                      created_at: '2026-01-01T00:00:00Z',
                      updated_at: '2026-01-01T00:00:00Z',
                    },
                  ],
                  error: null,
                };
        } else if (table === 'club_members' && columns.includes('clubs:club_id')) {
          value = {
            data: [
              {
                club_id: CLUB_ID,
                role: 'owner',
                chip_balance: 250,
                clubs: {
                  name: 'Directory Club',
                  club_id: 101,
                  slug: 'directory-club',
                  logo_url: null,
                  is_union: false,
                  owner_id: USER_ID,
                },
              },
            ],
            error: null,
          };
        }
        return Promise.resolve(value).then(resolve);
      };
      return builder as never;
    });
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /open another club cashier/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load your club cashiers.'
    );
    expect(screen.queryByRole('option', { name: /Directory Club/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /Recovered Union/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Directory Club/i })).toBeInTheDocument();
    expect(unionAttempts).toBe(2);
  });

  it('loads an owner-visible managed transfer through the role-scoped ledger RPC', async () => {
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
                      owner_id: USER_ID,
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
    vi.mocked(supabase.rpc).mockImplementation((name: string) => {
      if (name === 'fn_club_trade_ledger') {
        return Promise.resolve({
          data: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              created_at: '2026-09-06T09:00:00Z',
              transaction_type: 'agent_wallet_send',
              amount: 50,
              from_user_id: '77777777-7777-4777-8777-777777777777',
              to_user_id: PLAYER_ID,
              notes: 'Cashier Send',
              metadata: { destination: 'player_wallet' },
              from_name: 'Alice Agent',
              to_name: 'Bob Player',
            },
          ],
          error: null,
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Balances synchronized')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Trade Record' }));
    expect(await screen.findByText('Transfer Alice Agent To Bob Player')).toBeInTheDocument();
    expect(screen.getAllByText('50')).toHaveLength(2);
    expect(supabase.rpc).toHaveBeenCalledWith('fn_club_trade_ledger', {
      p_club_id: CLUB_ID,
      p_limit: 51,
      p_offset: 0,
    });
  });

  it('does not invalidate the request that loads the first Trade tab', async () => {
    const membershipGate = deferred<{
      data: { role: string; chip_balance: number };
      error: null;
    }>();

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
      builder.maybeSingle = vi.fn(() => {
        if (table === 'club_members') return membershipGate.promise;
        if (table === 'agents') {
          return Promise.resolve({ data: { agent_wallet_balance: 500 }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.then = (resolve: (value: unknown) => unknown) => {
        const value =
          table === 'club_members' && columns.includes('clubs:club_id')
            ? {
                data: [
                  {
                    club_id: CLUB_ID,
                    role: 'owner',
                    chip_balance: 250,
                    clubs: { name: 'Phase One Club', club_id: 101, logo_url: null },
                  },
                ],
                error: null,
              }
            : { data: [], error: null, count: 0 };
        return Promise.resolve(value).then(resolve);
      };
      return builder as never;
    });

    vi.mocked(supabase.rpc).mockImplementation((name: string) => {
      if (name === 'fn_club_cashier_members_page_v3') {
        return Promise.resolve({
          data: [
            {
              user_id: PLAYER_ID,
              name: 'Loaded Player',
              username: 'loaded_player',
              avatar_url: null,
              role: 'player',
              role_rank: 0,
              chip_balance: 75,
              is_horse: false,
              depth: 1,
              player_number: 'P-1',
            },
          ],
          error: null,
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Loading Members...')).toBeInTheDocument());

    await act(async () => {
      membershipGate.resolve({ data: { role: 'owner', chip_balance: 250 }, error: null });
      await membershipGate.promise;
    });

    await waitFor(() => expect(screen.getByText('Loaded Player')).toBeInTheDocument());
    expect(screen.queryByText('Loading Members...')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Trade$/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('publishes the first keyset page while the continuation is still loading', async () => {
    const secondPage = deferred<{ data: []; error: null }>();
    let rosterCalls = 0;

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of ['eq', 'in', 'or', 'order', 'limit', 'range']) {
        builder[method] = vi.fn(chain);
      }
      builder.select = vi.fn(chain);
      builder.maybeSingle = vi.fn(() =>
        Promise.resolve(
          table === 'club_members'
            ? { data: { role: 'owner', chip_balance: 250 }, error: null }
            : table === 'agents'
              ? { data: { agent_wallet_balance: 500 }, error: null }
              : { data: null, error: null }
        )
      );
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      return builder as never;
    });

    vi.mocked(supabase.rpc).mockImplementation((name: string) => {
      if (name !== 'fn_club_cashier_members_page_v3') {
        return Promise.resolve({ data: [], error: null }) as never;
      }
      rosterCalls++;
      if (rosterCalls > 1) return secondPage.promise as never;
      return Promise.resolve({
        data: Array.from({ length: 500 }, (_, index) => ({
          user_id:
            index === 0 ? PLAYER_ID : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          name: index === 0 ? 'First Page Player' : `Player ${index}`,
          username: '',
          avatar_url: null,
          role: 'player',
          role_rank: 0,
          chip_balance: index,
          is_horse: false,
          depth: 1,
          player_number: null,
        })),
        error: null,
      }) as never;
    });

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Player 499')).toBeInTheDocument());
    expect(screen.getByText(/500 Members Ready. Loading The Rest/)).toBeInTheDocument();

    await act(async () => {
      secondPage.resolve({ data: [], error: null });
      await secondPage.promise;
    });
    await waitFor(() => expect(screen.queryByText(/Loading The Rest/)).not.toBeInTheDocument());
  });

  it('locks the reconciliation and money controls as soon as the browser goes offline', async () => {
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
                    clubs: { name: 'Offline Guard Club', club_id: 101, logo_url: null },
                  },
                ],
                error: null,
              }
            : { data: [], error: null, count: 0 };
        return Promise.resolve(value).then(resolve);
      };
      return builder as never;
    });
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Balances synchronized')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Reconcile Now' })).toBeEnabled();

    await act(async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });

    expect(screen.getByText('Cashier offline; money actions are locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconcile Now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Claim Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open The Club Bank Cashier' })).toBeDisabled();
  });

  it('hydrates an unresolved batch after a reload and reopens the exact unchanged intent', async () => {
    expect(
      writeCashierTransferRecovery({
        version: 1,
        userId: USER_ID,
        clubId: CLUB_ID,
        kind: 'send',
        amount: 42.5,
        targetIds: [PLAYER_ID],
        failures: [
          {
            userId: PLAYER_ID,
            name: 'Recovered Player',
            message: 'Outcome Not Yet Confirmed',
          },
        ],
        submissionId: '44444444-4444-4444-8444-444444444444',
        opIds: { [PLAYER_ID]: '55555555-5555-4555-8555-555555555555' },
        createdAt: Date.now(),
      })
    ).toBe(true);

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
                    clubs: { name: 'Recovery Club', club_id: 101, logo_url: null },
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
          name === 'fn_club_cashier_members_page_v3'
            ? {
                data: [
                  {
                    user_id: PLAYER_ID,
                    name: 'Recovered Player',
                    username: 'recovered_player',
                    avatar_url: null,
                    role: 'player',
                    role_rank: 0,
                    chip_balance: 75,
                    is_horse: false,
                    depth: 1,
                    player_number: 'P-1',
                  },
                ],
                error: null,
              }
            : { data: [], error: null }
        ) as never
    );

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Transfer Recovery Required')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Recovered Player')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Review And Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Send Out/ })).toBeInTheDocument()
    );
    expect(screen.getByRole('spinbutton', { name: 'Amount Per Player' })).toHaveValue(42.5);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    expect(localStorage.length).toBe(1);
  });

  it('does not call the money RPC when the preflight recovery journal cannot be persisted', async () => {
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
                    clubs: { name: 'Storage Guard Club', club_id: 101, logo_url: null },
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
          name === 'fn_club_cashier_members_page_v3'
            ? {
                data: [
                  {
                    user_id: PLAYER_ID,
                    name: 'Storage Guard Player',
                    username: 'storage_guard',
                    avatar_url: null,
                    role: 'player',
                    role_rank: 0,
                    chip_balance: 75,
                    is_horse: false,
                    depth: 1,
                    player_number: 'P-2',
                  },
                ],
                error: null,
              }
            : { data: [], error: null }
        ) as never
    );

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    const player = await screen.findByRole('checkbox', { name: /Storage Guard Player/ });
    await waitFor(() => expect(screen.getByText('Balances synchronized')).toBeInTheDocument());
    fireEvent.click(player);
    fireEvent.click(screen.getByRole('button', { name: 'Send Out' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Amount Per Player' }), {
      target: { value: '10' },
    });

    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      await waitFor(() =>
        expect(toastMocks.error).toHaveBeenCalledWith(
          'Cashier Safety Storage Is Unavailable. Free Browser Storage And Try Again'
        )
      );
      expect(
        vi.mocked(supabase.rpc).mock.calls.some(([name]) => name === 'fn_cashier_batch_transfer')
      ).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });

  it('reuses the exact chip-request operation after a lost response and remount', async () => {
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
                    clubs: { name: 'Request Recovery Club', club_id: 101, logo_url: null },
                  },
                ],
                error: null,
              }
            : { data: [], error: null, count: 0 };
        return Promise.resolve(value).then(resolve);
      };
      return builder as never;
    });

    const requestCalls: Array<Record<string, unknown>> = [];
    vi.mocked(supabase.rpc).mockImplementation((name: string, args?: Record<string, unknown>) => {
      if (name === 'fn_request_chips') {
        requestCalls.push(args || {});
        return Promise.resolve(
          requestCalls.length === 1
            ? { data: null, error: new TypeError('Failed to fetch') }
            : {
                data: { success: true, replayed: true, request_id: PLAYER_ID },
                error: null,
              }
        ) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    const renderCashier = () =>
      render(
        <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
          <Routes>
            <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
          </Routes>
        </MemoryRouter>
      );

    const firstMount = renderCashier();
    await waitFor(() => expect(screen.getByText('Balances synchronized')).toBeInTheDocument());
    fireEvent.click(await screen.findByRole('tab', { name: 'Chip Requests' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request Chips From Your Agent' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Chips Requested' }), {
      target: { value: '75' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Table Seven' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Request' }));
    await waitFor(() => expect(requestCalls).toHaveLength(1));
    const firstOperationId = requestCalls[0].p_op_id;
    expect(firstOperationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(localStorageHasPrefix(CASHIER_REQUEST_RECOVERY_PREFIX)).toBe(true);

    firstMount.unmount();
    const secondMount = renderCashier();
    await waitFor(() => expect(screen.getByText('Balances synchronized')).toBeInTheDocument());
    fireEvent.click(await screen.findByRole('tab', { name: 'Chip Requests' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request Chips From Your Agent' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Chips Requested' }), {
      target: { value: '75' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
      target: { value: '  Table Seven  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Request' }));

    await waitFor(() => expect(requestCalls).toHaveLength(2));
    expect(requestCalls[1].p_op_id).toBe(firstOperationId);
    await waitFor(() => expect(localStorageHasPrefix(CASHIER_REQUEST_RECOVERY_PREFIX)).toBe(false));
    secondMount.unmount();
  });

  it('reports reconciliation attention when a promised verification read fails', async () => {
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
              ? { data: null, error: { message: 'wallet read failed' } }
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
                    clubs: { name: 'Verification Club', club_id: 101, logo_url: null },
                  },
                ],
                error: null,
              }
            : { data: [], error: null, count: 0 };
        return Promise.resolve(value).then(resolve);
      };
      return builder as never;
    });
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);

    render(
      <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/cashier`]}>
        <Routes>
          <Route path="/clubs/:clubId/cashier" element={<CashierTradePage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getByText('Agent wallet could not be verified')).toBeInTheDocument()
    );
    expect(screen.getByText('Not Yet Verified')).toBeInTheDocument();
    // The wallet warning is painted as soon as that read settles, while the
    // roster continuation can still be loading. On a busy CI runner the
    // reconcile control is therefore correctly disabled for a few more
    // milliseconds; clicking it early is a browser no-op and never exercises
    // the promised verification path this test is meant to prove.
    const reconcile = screen.getByRole('button', { name: 'Reconcile Now' });
    await waitFor(() => expect(reconcile).toBeEnabled());
    fireEvent.click(reconcile);
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('Cashier Reconciliation Needs Attention')
    );
    expect(toastMocks.success).not.toHaveBeenCalledWith('Cashier Balances Reconciled');
  });
});
