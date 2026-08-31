import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../src/lib/supabase';
import CashierTradePage from '../src/pages/CashierTradePage';

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: USER_ID }, isHydrating: false }),
}));

vi.mock('../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
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
});
