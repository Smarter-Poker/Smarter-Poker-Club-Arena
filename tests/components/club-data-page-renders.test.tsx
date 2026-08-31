import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const snapshot = {
  range: { start: '2026-08-17', end: '2026-08-30', days: 14 },
  previous_range: { start: '2026-08-03', end: '2026-08-16', days: 14 },
  summary: {
    games: 1,
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
const realtimeState = vi.hoisted(() => ({
  channels: [] as Array<Record<string, any>>,
  busHandler: null as ((payload: unknown) => void) | null,
  busEvents: [] as string[],
}));

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

vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (options: Record<string, any>) => realtimeState.channels.push(options),
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: (events: string[], handler: (payload: unknown) => void) => {
    realtimeState.busEvents = events;
    realtimeState.busHandler = handler;
  },
}));

import ClubDataPage from '../../src/pages/club/ClubDataPage';
import {
  CLUB_DATA_CACHE_PREFIX,
  clubDataQueryKey,
  writeClubDataCache,
} from '../../src/lib/clubDataCache';

afterEach(() => cleanup());

beforeEach(() => {
  authState.current = { user: { id: 'owner-1' }, isHydrating: false };
  routeState.clubId = CLUB_ID;
  rpcMock.mockReset();
  downloadMock.mockClear();
  sessionStorage.clear();
  realtimeState.channels = [];
  realtimeState.busHandler = null;
  realtimeState.busEvents = [];
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
  it('paints a recent verified snapshot immediately while the live RPC revalidates', async () => {
    const endDate = new Date().toISOString().slice(0, 10);
    const start = new Date(`${endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 13);
    const cachedSnapshot = {
      ...snapshot,
      rows: [{ ...snapshot.rows[0], id: 'cached-game', name: 'Cached Table' }],
    };
    const queryKey = clubDataQueryKey({
      kind: 'games',
      startDate: start.toISOString().slice(0, 10),
      endDate,
      game: 'ALL',
      stakes: 'ALL',
      search: '',
      gameSort: 'recent',
    });
    writeClubDataCache('owner-1', CLUB_ID, queryKey, {
      snapshot: cachedSnapshot,
      cursor: null,
      hasMore: false,
    });
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'ca_club_data_snapshot') return new Promise(() => undefined);
      if (fn === 'ca_club_union_invoices') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });

    render(<ClubDataPage />);

    expect(await screen.findByText('Cached Table')).toBeInTheDocument();
    expect(screen.getByText('Recent Verified Snapshot')).toBeInTheDocument();
    expect(
      screen.getByText('Showing A Recent Verified Snapshot While Live Numbers Refresh.')
    ).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('ca_club_data_snapshot', expect.any(Object));
  });

  it('wires scoped realtime tables and coalesces a mutation into an authoritative refresh', async () => {
    render(<ClubDataPage />);
    await screen.findByText('Shark Table One');

    const latestByTable = new Map<string, Record<string, any>>();
    for (const channel of realtimeState.channels) latestByTable.set(channel.table, channel);
    expect([...latestByTable.keys()].sort()).toEqual([
      'club_members',
      'settlement_invoices',
      'tables',
      'tournaments',
    ]);
    for (const channel of latestByTable.values()) {
      expect(channel.filter).toBe(`club_id=eq.${CLUB_ID}`);
      expect(channel.enabled).toBe(true);
    }
    act(() => {
      for (const channel of latestByTable.values()) channel.onSubscriptionStatus('SUBSCRIBED');
    });
    expect(screen.getByText('4 / 4')).toBeInTheDocument();
    act(() => latestByTable.get('tables')?.onSubscriptionStatus('CLOSED'));
    expect(
      screen.getByText('The 60-Second Verified Poll Remains Active While Live Feeds Reconnect.')
    ).toBeInTheDocument();

    const before = rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot').length;
    act(() => latestByTable.get('tables')?.onPayload({ eventType: 'UPDATE' }));
    expect(
      Object.keys(sessionStorage).filter((key) => key.startsWith(CLUB_DATA_CACHE_PREFIX))
    ).toHaveLength(0);
    await waitFor(
      () =>
        expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot').length).toBe(
          before + 1
        ),
      { timeout: 2_000 }
    );
  });

  it('renders the operator hero and live financial summary', async () => {
    render(<ClubDataPage />);

    expect(screen.getByRole('heading', { name: /Read The Room/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2,450.00')).toBeInTheDocument());
    expect(screen.getByText('Shark Table One')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Games' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('heading', { name: 'Data Integrity' })).toBeInTheDocument();
    expect(screen.getByText('12 / 12')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
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
      if (fn === 'ca_club_data_snapshot') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { data: snapshot, error: null };
      }
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
    // The control exists during the cold snapshot read but is intentionally
    // disabled. Clicking it before the ledger is verified is a no-op in the
    // browser, which a fast local runner can hide by finishing the read first.
    expect(exportButton).toBeDisabled();
    await waitFor(() => expect(exportButton).toBeEnabled(), { timeout: 10_000 });
    fireEvent.click(exportButton);

    // Assert the export side effect first. Under the full CI worker load React
    // can commit the two mirrored status regions after the default five-second
    // test deadline even though the immutable export already completed.
    await waitFor(() => expect(downloadMock).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(
      await screen.findAllByText('Exported all 2 games.', undefined, { timeout: 10_000 })
    ).toHaveLength(2);
    expect(downloadMock.mock.calls[0][1].split('\n')).toHaveLength(3);
    expect(rpcMock).toHaveBeenCalledWith(
      'ca_club_game_export_start',
      expect.objectContaining({ p_sort: 'recent', p_request_id: expect.any(String) })
    );
    expect(rpcMock).toHaveBeenCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-1',
    });
  }, 20_000);

  it('keeps internal player automation metadata out of the operator UI', async () => {
    render(<ClubDataPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await waitFor(() => expect(screen.getByText('Table Regular')).toBeInTheDocument());
    expect(screen.getByRole('list', { name: 'Players' })).toHaveAttribute('tabindex', '0');
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

  it('keeps verified game rows visible when a background refresh is transiently refused', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let snapshotRequest = 0;
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') {
        snapshotRequest += 1;
        return snapshotRequest === 1
          ? { data: snapshot, error: null }
          : { data: null, error: { code: '57014', message: 'statement timeout' } };
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    try {
      render(<ClubDataPage />);
      await screen.findByText('Shark Table One');
      const refresh = screen.getByRole('button', { name: 'Refresh Club Ledger' });
      await waitFor(() => expect(refresh).toBeEnabled());

      fireEvent.click(refresh);

      await screen.findByText(
        /Live Refresh Is Delayed\. Showing The Last Verified Snapshot/i,
        {},
        { timeout: 12_000 }
      );
      expect(screen.getByText('Shark Table One')).toBeInTheDocument();
      expect(screen.queryByText('Could not load club data.')).not.toBeInTheDocument();
      expect(screen.getByText(/Showing The Last Verified Snapshot/i)).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  }, 15_000);

  it('keeps verified player rows visible when a background refresh is transiently refused', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<ClubDataPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
      await screen.findByText('Table Regular');

      rpcMock.mockImplementation(async (fn: string) => {
        if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
        if (fn === 'ca_club_union_invoices') return { data: [], error: null };
        if (fn === 'ca_club_player_breakdown' || fn === 'ca_club_player_page') {
          return { data: null, error: { code: '57014', message: 'statement timeout' } };
        }
        return { data: null, error: null };
      });

      const before = rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_player_breakdown').length;
      act(() => realtimeState.busHandler?.({ clubId: CLUB_ID }));

      await waitFor(
        () =>
          expect(
            rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_player_breakdown').length
          ).toBe(before + 1),
        { timeout: 2_000 }
      );
      expect(screen.getByText('Table Regular')).toBeInTheDocument();
      expect(screen.queryByText('Could not load player data.')).not.toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
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
    // Three cancellations must be healed before the verified row appears. A
    // visibility refresh may race the final assertion in a loaded CI browser,
    // so constrain that independent refresh without pretending it is a fifth
    // retry of the failed cold read.
    expect(snapshotRequest).toBeGreaterThanOrEqual(4);
    expect(snapshotRequest).toBeLessThanOrEqual(5);
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

    fireEvent.click(screen.getByRole('button', { name: 'Biggest Losers' }));

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

  it('serves the first metric-sorted continuation from the initial ranked query', async () => {
    const rankedRows = Array.from({ length: 200 }, (_, index) => ({
      ...snapshot.rows[0],
      id: `ranked-game-${index + 1}`,
      name: `Ranked Game ${index + 1}`,
      fee: 10_000 - index,
      started_at: new Date(Date.UTC(2026, 7, 30, 12, 0, 0) - index * 1_000).toISOString(),
    }));
    const rankedCursor = { value: 9_801, time: 1_777_463_801, kind: 'CASH', id: 'ranked-game-200' };
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ca_club_data_snapshot') {
        return { data: { ...snapshot, row_count: 250 }, error: null };
      }
      if (fn === 'ca_club_game_page') {
        expect(args?.p_limit).toBe(200);
        return {
          data: {
            rows: rankedRows,
            next_cursor: rankedCursor,
            has_more: true,
            filtered_count: 250,
            generated_at: snapshot.generated_at,
          },
          error: null,
        };
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Highest Fee' }));

    const loadMore = await screen.findByRole('button', {
      name: 'Load More Games - 100 Of 250',
    });
    const rankedCallsBeforeClick = rpcMock.mock.calls.filter(
      ([fn]) => fn === 'ca_club_game_page'
    ).length;
    fireEvent.click(loadMore);

    await screen.findByRole('button', { name: 'Load More Games - 200 Of 250' });
    expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_game_page')).toHaveLength(
      rankedCallsBeforeClick
    );
  });
});
