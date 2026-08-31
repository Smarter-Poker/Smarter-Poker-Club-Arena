import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const snapshot = {
  range: { start: '2026-08-17', end: '2026-08-30', days: 14 },
  previous_range: { start: '2026-08-03', end: '2026-08-16', days: 14 },
  summary: {
    games: 12,
    total_winnings: 2450,
    mtt_winnings: 500,
    cash_winnings: 1950,
    fee: 321.5,
    cash_fee: 250,
    mtt_fee: 71.5,
    hands: 900,
  },
  previous: {
    games: 10,
    total_winnings: 2000,
    mtt_winnings: 400,
    cash_winnings: 1600,
    fee: 300,
    hands: 800,
  },
  delta: { fee_pct: 7.2, games_pct: 20, winnings_abs: 450, fee_abs: 21.5 },
  rows: [
    {
      kind: 'CASH',
      id: 'game-1',
      name: 'Shark Table One',
      variant: 'NLH',
      game_class: 'HOLDEM',
      stakes_tier: 'SMALL',
      blinds: '1 / 2',
      rake_percent: 10,
      started_at: '2026-08-30T12:00:00Z',
      status: 'complete',
      creator_id: 'player-1',
      creator_name: 'Dealer One',
      creator_avatar: null,
      fee: 42.5,
      winnings: 120,
      hands: 80,
      players: 6,
    },
  ],
  row_count: 1,
  union_id: 'union-1',
  data_updated_at: '2026-08-30T12:05:00Z',
  generated_at: '2026-08-30T12:05:02Z',
};

const playerBreakdown = {
  range: snapshot.range,
  rake_complete_through: '2026-08-29',
  totals: { players: 1, net: 120, rake: 42.5, hands: 80 },
  players: [
    {
      user_id: 'player-1',
      username: 'Table Regular',
      avatar_url: null,
      is_horse: true,
      net: 120,
      cash_net: 120,
      tournament_net: 0,
      rake: 42.5,
      hands: 80,
    },
  ],
  player_count: 1,
  generated_at: '2026-08-30T12:05:02Z',
};

const gamePage = {
  rows: snapshot.rows,
  next_cursor: null,
  has_more: false,
  filtered_count: snapshot.row_count,
  generated_at: snapshot.generated_at,
};

const playerPage = {
  rows: playerBreakdown.players,
  next_cursor: null,
  has_more: false,
  filtered_count: playerBreakdown.player_count,
  generated_at: playerBreakdown.generated_at,
};

const latestInvoice = {
  invoice_id: 'invoice-1',
  status: 'awaiting_payment',
  issued_at: '2026-08-30T09:00:00Z',
  due_at: '2026-09-02T09:00:00Z',
  amount: 350,
  direction: 'club owes union',
  period_start: '2026-08-23',
  period_end: '2026-08-29',
  breakdown: { rake_generated: 500, rakeback_due: 150, union_fee_kept: 350 },
  message_sent: true,
};

const authState = vi.hoisted(() => ({
  current: { user: { id: 'owner-1' } as { id: string } | null, isHydrating: false },
}));

const routeState = vi.hoisted(() => ({ clubId: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4' }));
const rpcMock = vi.hoisted(() => vi.fn());
const fromMock = vi.hoisted(() => vi.fn());
const downloadMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => authState.current,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ clubId: routeState.clubId }),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

vi.mock('../../src/utils/downloadCsv', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/downloadCsv')>(
    '../../src/utils/downloadCsv'
  );
  return { ...actual, downloadCsv: downloadMock };
});

import ClubDataPage from '../../src/pages/club/ClubDataPage';

afterEach(() => cleanup());

beforeEach(() => {
  authState.current = { user: { id: 'owner-1' }, isHydrating: false };
  routeState.clubId = CLUB_ID;
  rpcMock.mockReset();
  downloadMock.mockClear();
  rpcMock.mockImplementation(async (fn: string) => {
    if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
    if (fn === 'ca_club_game_page') return { data: gamePage, error: null };
    if (fn === 'ca_club_player_breakdown') return { data: playerBreakdown, error: null };
    if (fn === 'ca_club_player_page') return { data: playerPage, error: null };
    if (fn === 'ca_club_union_invoices') return { data: [], error: null };
    return { data: null, error: null };
  });
  fromMock.mockReset();
  fromMock.mockImplementation(() => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { name: 'Shark Club' }, error: null }) }),
    }),
  }));
});

describe('ClubDataPage', () => {
  it('renders the operator hero and live financial summary', async () => {
    render(<ClubDataPage />);

    expect(screen.getByRole('heading', { name: /Read The Room/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2,450.00')).toBeInTheDocument());
    expect(screen.getByText('Shark Table One')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export As CSV' })).toBeEnabled();
    expect(rpcMock).toHaveBeenCalledWith(
      'ca_club_data_snapshot',
      expect.objectContaining({ p_limit: 100 })
    );
    expect(rpcMock.mock.calls.some(([fn]) => fn === 'ca_club_game_page')).toBe(false);
  });

  it('exports the exact prepared game snapshot instead of only the visible page', async () => {
    const secondRow = { ...snapshot.rows[0], id: 'game-2', name: 'Shark Table Two' };
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      if (fn === 'ca_club_game_export_start') {
        return { data: { export_id: 'export-1', total_rows: 2, status: 'ready' }, error: null };
      }
      if (fn === 'ca_club_data_export_page') {
        return {
          data: {
            rows: [snapshot.rows[0], secondRow],
            total_rows: 2,
            next_offset: 2,
            has_more: false,
          },
          error: null,
        };
      }
      if (fn === 'ca_club_data_export_cancel') return { data: true, error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);
    const exportButton = await screen.findByRole('button', { name: 'Export As CSV' });
    fireEvent.click(exportButton);

    expect(await screen.findAllByText('Exported all 2 games.')).toHaveLength(2);
    expect(downloadMock).toHaveBeenCalledOnce();
    expect(downloadMock.mock.calls[0][1].split('\n')).toHaveLength(3);
    expect(rpcMock).toHaveBeenCalledWith(
      'ca_club_game_export_start',
      expect.objectContaining({ p_sort: 'recent', p_request_id: expect.any(String) })
    );
    expect(rpcMock).toHaveBeenCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-1',
    });
  });

  it('keeps internal player automation metadata out of the operator UI', async () => {
    render(<ClubDataPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await waitFor(() => expect(screen.getByText('Table Regular')).toBeInTheDocument());
    expect(screen.queryByText('HORSE')).not.toBeInTheDocument();
  });

  it('waits for auth restoration before making protected data calls', async () => {
    authState.current = { user: null, isHydrating: true };
    const { rerender } = render(<ClubDataPage />);

    expect(screen.getByText('Opening Club Data')).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();

    authState.current = { user: { id: 'owner-1' }, isHydrating: false };
    rerender(<ClubDataPage />);

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('ca_club_data_snapshot', expect.any(Object))
    );
    expect(fromMock).toHaveBeenCalledWith('clubs');
  });

  it('clears the previous club ledger before a new route can resolve', async () => {
    const secondClubId = 'b52545cc-9e1d-411b-9f1e-f9c4e76bf0e5';
    let resolveSecondSnapshot!: (result: { data: typeof snapshot; error: null }) => void;
    rpcMock.mockImplementation((fn: string, args?: { p_club_id?: string }) => {
      if (fn === 'ca_club_data_snapshot' && args?.p_club_id === secondClubId) {
        return new Promise((resolve) => {
          resolveSecondSnapshot = resolve;
        });
      }
      if (fn === 'ca_club_data_snapshot') return Promise.resolve({ data: snapshot, error: null });
      if (fn === 'ca_club_game_page') return Promise.resolve({ data: gamePage, error: null });
      if (fn === 'ca_club_player_breakdown') {
        return Promise.resolve({ data: playerBreakdown, error: null });
      }
      if (fn === 'ca_club_player_page') return Promise.resolve({ data: playerPage, error: null });
      if (fn === 'ca_club_union_invoices') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });

    const { rerender } = render(<ClubDataPage />);
    await screen.findByText('Shark Table One');

    routeState.clubId = secondClubId;
    rerender(<ClubDataPage />);

    expect(screen.queryByText('Shark Table One')).not.toBeInTheDocument();
    expect(screen.queryByText('2,450.00')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        'ca_club_data_snapshot',
        expect.objectContaining({ p_club_id: secondClubId })
      )
    );
    resolveSecondSnapshot({ data: snapshot, error: null });
    await screen.findByText('Shark Table One');
  });

  it('supports arrow-key tab navigation with a roving tab stop', async () => {
    render(<ClubDataPage />);
    const gamesTab = screen.getByRole('tab', { name: 'Games' });
    const playersTab = screen.getByRole('tab', { name: 'Players' });

    expect(gamesTab).toHaveAttribute('tabindex', '0');
    expect(playersTab).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(gamesTab, { key: 'ArrowRight' });

    await waitFor(() => expect(playersTab).toHaveAttribute('aria-selected', 'true'));
    expect(playersTab).toHaveAttribute('tabindex', '0');
    await waitFor(() => expect(playersTab).toHaveFocus());
  });

  it('refreshes the game ledger and union statement together', async () => {
    render(<ClubDataPage />);
    const refresh = screen.getByRole('button', { name: 'Refresh Club Ledger' });

    await waitFor(() => expect(refresh).toBeEnabled());
    expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot')).toHaveLength(1);
    expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_union_invoices')).toHaveLength(1);

    fireEvent.click(refresh);

    await waitFor(() =>
      expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot')).toHaveLength(2)
    );
    expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_union_invoices')).toHaveLength(2);
    await screen.findByText('Club Ledger Refreshed.');
  });

  it('keeps the last verified statement visible through a transient refresh failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let invoiceRequest = 0;
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
      if (fn === 'ca_club_game_page') return { data: gamePage, error: null };
      if (fn === 'ca_club_player_breakdown') return { data: playerBreakdown, error: null };
      if (fn === 'ca_club_player_page') return { data: playerPage, error: null };
      if (fn === 'ca_club_union_invoices') {
        invoiceRequest += 1;
        return invoiceRequest === 1
          ? { data: [latestInvoice], error: null }
          : { data: null, error: { message: 'temporary network failure' } };
      }
      return { data: null, error: null };
    });

    try {
      render(<ClubDataPage />);
      await screen.findByText(/350\.00/);
      const refresh = screen.getByRole('button', { name: 'Refresh Club Ledger' });
      await waitFor(() => expect(refresh).toBeEnabled());

      fireEvent.click(refresh);

      await screen.findByText(/Could Not Refresh Your Union Statement/i);
      expect(screen.getByText(/Showing The Last Verified Statement/i)).toBeInTheDocument();
      expect(screen.getByText(/350\.00/)).toBeInTheDocument();
      expect(screen.getByText('Refresh Finished With Some Data Unavailable.')).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('heals one transient cold-start cancellation before exposing an error state', async () => {
    let snapshotRequest = 0;
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') {
        snapshotRequest += 1;
        return snapshotRequest === 1
          ? {
              data: null,
              error: { code: '57014', message: 'canceling statement due to statement timeout' },
            }
          : { data: snapshot, error: null };
      }
      if (fn === 'ca_club_game_page') return { data: gamePage, error: null };
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);

    await screen.findByText('Shark Table One');
    expect(snapshotRequest).toBe(2);
    expect(screen.queryByText('Could not load club data.')).not.toBeInTheDocument();
  });

  it('keeps healing through a contended cold start before exposing an error state', async () => {
    let snapshotRequest = 0;
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') {
        snapshotRequest += 1;
        return snapshotRequest < 4
          ? {
              data: null,
              error: { code: '57014', message: 'canceling statement due to statement timeout' },
            }
          : { data: snapshot, error: null };
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);

    await screen.findByText('Shark Table One', {}, { timeout: 5_000 });
    expect(snapshotRequest).toBe(4);
    expect(screen.queryByText('Could not load club data.')).not.toBeInTheDocument();
  });

  it('aborts a protected request when its response deadline expires', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let snapshotSignal: AbortSignal | undefined;
    const pending = new Promise<never>(() => undefined);
    const abortableSnapshot = {
      then: pending.then.bind(pending),
      abortSignal(signal: AbortSignal) {
        snapshotSignal = signal;
        return this;
      },
    };
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'ca_club_data_snapshot') return abortableSnapshot;
      if (fn === 'ca_club_game_page') return Promise.resolve({ data: gamePage, error: null });
      if (fn === 'ca_club_union_invoices') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });

    try {
      render(<ClubDataPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(55_000);
      });

      expect(snapshotSignal?.aborted).toBe(true);
      expect(
        screen.getByText('Club data took too long to respond. Try again.')
      ).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('asks the server for the selected player order before slicing the page', async () => {
    render(<ClubDataPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await screen.findByText('Table Regular');

    fireEvent.click(screen.getByRole('button', { name: 'Biggest losers' }));

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        'ca_club_player_page',
        expect.objectContaining({ p_sort: 'losers', p_cursor: null })
      )
    );
  });

  it('continues the Games ledger from the opaque server cursor without duplicates', async () => {
    const secondRow = {
      ...snapshot.rows[0],
      id: 'game-2',
      name: 'Shark Table Two',
      started_at: '2026-08-30T11:00:00Z',
    };
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') {
        return { data: { ...snapshot, row_count: 2 }, error: null };
      }
      if (fn === 'ca_club_game_page') {
        return {
          data: {
            ...gamePage,
            rows: [snapshot.rows[0], secondRow],
            next_cursor: null,
            has_more: false,
            filtered_count: 2,
          },
          error: null,
        };
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      if (fn === 'ca_club_player_breakdown') return { data: playerBreakdown, error: null };
      if (fn === 'ca_club_player_page') return { data: playerPage, error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);

    await screen.findByText('Shark Table Two');
    expect(screen.getAllByText('Shark Table One')).toHaveLength(1);
    expect(rpcMock).toHaveBeenCalledWith(
      'ca_club_game_page',
      expect.objectContaining({
        p_cursor: expect.objectContaining({ kind: 'CASH', id: 'game-1' }),
      })
    );
  });
});
