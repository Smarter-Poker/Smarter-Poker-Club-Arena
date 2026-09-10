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

/**
 * The rake snapshot panel is stubbed here, and the reason is worth writing down
 * because the failure was confusing.
 *
 * This file's bus mock keeps ONE handler:  realtimeState.busHandler = handler.
 * The panel subscribes to the same events as the page, so the moment it gained
 * a subscription the panel's handler replaced the page's, and firing
 * busHandler exercised the panel while asserting on the page. Two tests began
 * failing with "expected 1 to be 2" - the page had simply never been told.
 *
 * Nothing was wrong in production: the real bus fans out to every subscriber
 * and both components refresh. The single-handler double could not represent a
 * second subscriber, and this file is about the LEDGER, not the panel, which
 * has its own tests. Stubbing it keeps the subject of these assertions the
 * thing they are named after - and removes the panel's unmocked RPC from the
 * stderr of every test in the file.
 */
vi.mock('../../src/components/club/RakeSnapshotPanel', () => ({
  default: () => null,
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

    // THE COLD READ IS HELD OPEN BY THE TEST, NOT BY A TIMER (2026-09-02).
    //
    // This used to `await setTimeout(50)` and then assert, one line below the
    // render, that the export button is disabled. That is a race against the
    // wall clock: `findByRole` polls, and on a loaded CI worker the first poll
    // can land after the 50ms has already elapsed - at which point the button
    // is legitimately enabled and the assertion fails on a branch that changed
    // nothing. Measured 2026-09-02: this test failed in CI while passing three
    // times out of three locally, and `main` itself was red on the same suite.
    //
    // A deferred promise removes the clock from the assertion entirely. The
    // read cannot finish until the test says so, so "disabled during the cold
    // read" is now a fact rather than a hope, however slow the runner is.
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') {
        await snapshotGate;
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
    // browser, and the gate above guarantees the read is still open here, so
    // this assertion no longer depends on how fast the runner is.
    await waitFor(() => expect(exportButton).toBeDisabled());
    releaseSnapshot();
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

  /**
   * THIS TEST USED TO ASSERT THE OPPOSITE, and the reason it changed matters.
   *
   * It read `queryByText('HORSE')` and required the flag to be absent. That was
   * written when ca_club_player_breakdown returned is_horse UNMASKED - to
   * anyone who could read club finances, which includes super agents, a role
   * the estate's own fn_can_see_horse_flag deliberately excludes. Hiding it in
   * the UI was the right defensive call while the database was handing it to
   * the wrong people.
   *
   * The database now masks it: staff get the truth, everyone else a uniform
   * false. So the flag only ARRIVES for an owner, co-owner or admin, and for
   * them it is the answer to a question they need - which of my top players is
   * a person. Painting it is now safe in the only case where it is non-false.
   *
   * Worth recording: the old assertion did not fail when the badge was added.
   * It searched for 'HORSE' and the badge renders 'Horse', uppercased in CSS -
   * so it passed by accident rather than by agreement. An assertion that would
   * not have noticed the change it existed to prevent is worse than none, so
   * both directions are now explicit.
   */
  it('names a horse for the staff entitled to know', async () => {
    render(<ClubDataPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await waitFor(() => expect(screen.getByText('Table Regular')).toBeInTheDocument());
    expect(screen.getByRole('list', { name: 'Players' })).toHaveAttribute('tabindex', '0');

    // The fixture's player carries is_horse: true, which only reaches a
    // viewer the database decided may see it.
    expect(screen.getByText('Horse')).toBeInTheDocument();
  });

  /**
   * A CLIENT-SIDE FILTER OVER A SERVER-PAGED LIST HAS TWO WAYS TO GO WRONG,
   * and Phase 4 shipped both of them before this test existed.
   *
   * The infinite-scroll trigger compared the virtual window's endIndex against
   * the length of the list ON SCREEN. Hiding horses on a club that is 577
   * horses and one person takes that length to 1, so `endIndex >= 1 - 8` is
   * already true before anyone scrolls; every page fetched is filtered
   * straight back out, the length never grows, and the condition never stops
   * being true. A filter became a fetch loop.
   *
   * Whether more rows exist on the SERVER is a fact about what has been
   * fetched, so the trigger reads the unfiltered length.
   */
  it('hiding horses does not turn the pager into a fetch loop', async () => {
    const manyHorses = Array.from({ length: 30 }, (_, i) => ({
      ...playerBreakdown.players[0],
      user_id: `horse-${i}`,
      username: `Horse ${i}`,
      is_horse: true,
    }));
    const onePerson = {
      ...playerBreakdown.players[0],
      user_id: 'person-1',
      username: 'The Only Person',
      is_horse: false,
    };
    const roster = [onePerson, ...manyHorses];

    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'ca_club_data_snapshot') return Promise.resolve({ data: snapshot, error: null });
      if (fn === 'ca_club_union_invoices') return Promise.resolve({ data: [], error: null });
      if (fn === 'ca_club_player_breakdown') {
        return Promise.resolve({
          data: { ...playerBreakdown, players: roster, player_count: 200 },
          error: null,
        });
      }
      if (fn === 'ca_club_player_page') {
        // filtered_count exceeds the rows returned, which is what makes
        // playersHasMore true and hands the pager a cursor. Without that the
        // loader can never fire and this test proves nothing - the first
        // version claimed 31 of 31 and the mutation it was written for passed.
        return Promise.resolve({
          data: {
            ...playerPage,
            rows: roster,
            has_more: true,
            filtered_count: 200,
            next_cursor: { v: 1 },
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<ClubDataPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await waitFor(() => expect(screen.getByText('The Only Person')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Hide Horses/i }));
    await waitFor(() => expect(screen.queryByText('Horse 0')).not.toBeInTheDocument());

    const after = rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_player_page').length;
    // Let any runaway effect run. A loop would add calls without bound.
    await new Promise((r) => setTimeout(r, 250));
    const later = rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_player_page').length;

    expect(later - after).toBeLessThanOrEqual(1);
    expect(screen.getByText('The Only Person')).toBeInTheDocument();
  });

  it('shows nothing at all when the flag was masked before it arrived', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'ca_club_data_snapshot') return Promise.resolve({ data: snapshot, error: null });
      if (fn === 'ca_club_union_invoices') return Promise.resolve({ data: [], error: null });
      if (fn === 'ca_club_player_breakdown') {
        return Promise.resolve({
          data: {
            ...playerBreakdown,
            players: playerBreakdown.players.map((p) => ({ ...p, is_horse: false })),
          },
          error: null,
        });
      }
      // The tab paints from the PAGE, not the breakdown, so the masked value
      // has to be here too - overriding only the breakdown left the list empty
      // and the test failed on the row rather than on the badge.
      if (fn === 'ca_club_player_page') {
        return Promise.resolve({
          data: {
            ...playerPage,
            rows: playerPage.rows.map((p) => ({ ...p, is_horse: false })),
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<ClubDataPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await waitFor(() => expect(screen.getByText('Table Regular')).toBeInTheDocument());

    // A masked viewer gets a uniform false, so there is no badge and no
    // filter - the control would be a switch that does nothing and invites
    // the question it is not allowed to answer.
    expect(screen.queryByText('Horse')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hide Horses|People Only/i })).toBeNull();
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

  it('keeps manual recovery available during a silent player reconciliation', async () => {
    render(<ClubDataPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await screen.findByText('Table Regular');

    const pendingPlayers: Array<() => void> = [];
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'ca_club_data_snapshot') return Promise.resolve({ data: snapshot, error: null });
      if (fn === 'ca_club_union_invoices') return Promise.resolve({ data: [], error: null });
      if (fn === 'ca_club_player_breakdown') {
        return new Promise((resolve) =>
          pendingPlayers.push(() => resolve({ data: playerBreakdown, error: null }))
        );
      }
      if (fn === 'ca_club_player_page') {
        return new Promise((resolve) =>
          pendingPlayers.push(() => resolve({ data: playerPage, error: null }))
        );
      }
      return Promise.resolve({ data: null, error: null });
    });

    const before = rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_player_breakdown').length;
    act(() => realtimeState.busHandler?.({ clubId: CLUB_ID }));
    await waitFor(
      () =>
        expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_player_breakdown').length).toBe(
          before + 1
        ),
      { timeout: 2_000 }
    );

    expect(screen.getByRole('button', { name: 'Refresh Club Ledger' })).toBeEnabled();
    expect(screen.getByText('Table Regular')).toBeInTheDocument();

    act(() => pendingPlayers.splice(0).forEach((resolve) => resolve()));
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
    // Four calls prove that three transient cancellations healed. A concurrent
    // visibility/revalidation signal may legitimately start another
    // authoritative read after first paint, so the user contract is a lower
    // bound rather than an arbitrary transport-call ceiling.
    expect(snapshotRequest).toBeGreaterThanOrEqual(4);
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

  it('revalidates a cached player sort without accepting the previous sort response', async () => {
    const endDate = new Date().toISOString().slice(0, 10);
    const start = new Date(endDate + 'T00:00:00Z');
    start.setUTCDate(start.getUTCDate() - 13);
    const loser = {
      ...playerBreakdown.players[0],
      user_id: 'loser-1',
      username: 'Cached Loser',
      net: -120,
    };
    const freshLoser = { ...loser, username: 'Verified Loser' };
    const nextLoser = {
      ...loser,
      user_id: 'loser-2',
      username: 'Next Loser',
      is_horse: false,
      net: -100,
    };
    const winnerRows = Array.from({ length: 100 }, (_, i) =>
      i === 0
        ? playerBreakdown.players[0]
        : { ...playerBreakdown.players[0], user_id: 'winner-' + i, username: 'Winner ' + i }
    );
    const loserRows = Array.from({ length: 100 }, (_, i) =>
      i === 0 ? loser : { ...loser, user_id: 'loser-other-' + i, username: 'Loser ' + i }
    );
    const winnerCursor = { value: 120, id: winnerRows[99].user_id };
    const loserCursor = { value: -120, id: loserRows[99].user_id };
    for (const [sort, rows, cursor] of [
      ['winners', winnerRows, winnerCursor],
      ['losers', loserRows, loserCursor],
    ] as const) {
      writeClubDataCache(
        'owner-1',
        CLUB_ID,
        clubDataQueryKey({
          kind: 'players',
          startDate: start.toISOString().slice(0, 10),
          endDate,
          playerSort: sort,
        }),
        { players: { ...playerBreakdown, players: rows, player_count: 101 }, cursor, hasMore: true }
      );
    }
    type Reply = { data: Record<string, unknown>; error: null };
    let resolveWinners: ((result: Reply) => void) | undefined;
    let resolveLosers: ((result: Reply) => void) | undefined;
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
      if (fn === 'ca_club_game_page') return { data: gamePage, error: null };
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      if (fn === 'ca_club_player_breakdown')
        return { data: { ...playerBreakdown, player_count: 101 }, error: null };
      if (fn === 'ca_club_player_page' && args?.p_cursor) {
        return { data: { ...playerPage, rows: [nextLoser], filtered_count: 101 }, error: null };
      }
      if (fn === 'ca_club_player_page' && args?.p_sort === 'losers') {
        return new Promise<Reply>((resolve) => {
          resolveLosers = resolve;
        });
      }
      if (fn === 'ca_club_player_page') {
        return new Promise<Reply>((resolve) => {
          resolveWinners = resolve;
        });
      }
      return { data: null, error: null };
    });

    try {
      render(<ClubDataPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
      await screen.findByText('Table Regular');
      await waitFor(() => expect(resolveWinners).toBeTypeOf('function'));
      fireEvent.click(screen.getByRole('button', { name: 'Biggest Losers' }));
      await screen.findByText('Cached Loser');
      await waitFor(() => expect(resolveLosers).toBeTypeOf('function'));

      await act(async () => {
        resolveWinners?.({
          data: {
            ...playerPage,
            rows: [{ ...winnerRows[0], username: 'Retired Winner' }, ...winnerRows.slice(1)],
            next_cursor: winnerCursor,
            has_more: true,
            filtered_count: 101,
          },
          error: null,
        });
      });
      expect(screen.getByText('Cached Loser')).toBeInTheDocument();
      expect(screen.queryByText('Retired Winner')).not.toBeInTheDocument();

      await act(async () => {
        resolveLosers?.({
          data: {
            ...playerPage,
            rows: [freshLoser, ...loserRows.slice(1)],
            next_cursor: loserCursor,
            has_more: true,
            filtered_count: 101,
          },
          error: null,
        });
      });
      await screen.findByText('Verified Loser');
      fireEvent.click(screen.getByRole('button', { name: 'Load More Players - 100 Of 101' }));
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /Load More Players|Loading More Players/ })
        ).not.toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole('button', { name: 'Hide Horses' }));
      await screen.findByText('Next Loser');
      expect(rpcMock).toHaveBeenCalledWith(
        'ca_club_player_page',
        expect.objectContaining({ p_sort: 'losers', p_cursor: loserCursor })
      );
      expect(
        rpcMock.mock.calls.some(
          ([fn, args]) =>
            fn === 'ca_club_player_page' &&
            args?.p_sort === 'losers' &&
            args?.p_cursor?.id === winnerCursor.id
        )
      ).toBe(false);
    } finally {
      await act(async () => {
        resolveWinners?.({ data: playerPage, error: null });
        resolveLosers?.({ data: playerPage, error: null });
      });
    }
  });

  it('keeps the new player pagination owned when an old sort page settles', async () => {
    const loser = {
      ...playerBreakdown.players[0],
      user_id: 'loser-1',
      username: 'Current Loser',
      net: -120,
    };
    const nextLoser = {
      ...loser,
      user_id: 'loser-2',
      username: 'Next Loser',
      is_horse: false,
      net: -100,
    };
    const winnerRows = Array.from({ length: 100 }, (_, i) =>
      i === 0
        ? playerBreakdown.players[0]
        : { ...playerBreakdown.players[0], user_id: 'winner-' + i, username: 'Winner ' + i }
    );
    const loserRows = Array.from({ length: 100 }, (_, i) =>
      i === 0 ? loser : { ...loser, user_id: 'loser-other-' + i, username: 'Loser ' + i }
    );
    type Reply = { data: Record<string, unknown>; error: null };
    let resolveOldPage: ((result: Reply) => void) | undefined;
    let resolveCurrentPage: ((result: Reply) => void) | undefined;
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
      if (fn === 'ca_club_game_page') return { data: gamePage, error: null };
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      if (fn === 'ca_club_player_breakdown')
        return { data: { ...playerBreakdown, player_count: 101 }, error: null };
      if (fn === 'ca_club_player_page' && args?.p_cursor) {
        return new Promise<Reply>((resolve) => {
          if (args.p_sort === 'losers') resolveCurrentPage = resolve;
          else resolveOldPage = resolve;
        });
      }
      if (fn === 'ca_club_player_page') {
        const rows = args?.p_sort === 'losers' ? loserRows : winnerRows;
        const row = rows[99];
        return {
          data: {
            ...playerPage,
            rows,
            next_cursor: { value: row.net, id: row.user_id },
            has_more: true,
            filtered_count: 101,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    try {
      render(<ClubDataPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
      const first = await screen.findByRole('button', { name: 'Load More Players - 100 Of 101' });
      fireEvent.click(first);
      await waitFor(() => expect(resolveOldPage).toBeTypeOf('function'));
      fireEvent.click(screen.getByRole('button', { name: 'Biggest Losers' }));
      await screen.findByText('Current Loser');
      const current = await screen.findByRole('button', { name: 'Load More Players - 100 Of 101' });
      await waitFor(() => expect(current).toBeEnabled());
      fireEvent.click(current);
      await waitFor(() => expect(resolveCurrentPage).toBeTypeOf('function'));
      await act(async () => {
        resolveOldPage?.({
          data: {
            ...playerPage,
            rows: [
              { ...playerBreakdown.players[0], user_id: 'retired-page', username: 'Retired Page' },
            ],
          },
          error: null,
        });
      });

      const pending = screen.getByRole('button', { name: 'Loading More Players' });
      expect(pending).toBeDisabled();
      fireEvent.click(pending);
      expect(
        rpcMock.mock.calls.filter(
          ([fn, args]) =>
            fn === 'ca_club_player_page' && args?.p_sort === 'losers' && args?.p_cursor
        )
      ).toHaveLength(1);
      expect(screen.queryByText('Retired Page')).not.toBeInTheDocument();
      await act(async () => {
        resolveCurrentPage?.({
          data: { ...playerPage, rows: [nextLoser], filtered_count: 101 },
          error: null,
        });
      });
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /Load More Players|Loading More Players/ })
        ).not.toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole('button', { name: 'Hide Horses' }));
      await screen.findByText('Next Loser');
    } finally {
      await act(async () => {
        resolveOldPage?.({ data: playerPage, error: null });
        resolveCurrentPage?.({ data: playerPage, error: null });
      });
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

  it('warms the first recent continuation after the initial verified snapshot', async () => {
    const recentRows = Array.from({ length: 200 }, (_, index) => ({
      ...snapshot.rows[0],
      id: `recent-game-${index + 1}`,
      name: `Recent Game ${index + 1}`,
      started_at: new Date(Date.UTC(2026, 7, 30, 12, 0, 0) - index * 1_000).toISOString(),
    }));
    let resolvePrefetch!: (result: { data: Record<string, unknown>; error: null }) => void;
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ca_club_data_snapshot') {
        expect(args?.p_limit).toBe(100);
        return {
          data: { ...snapshot, rows: recentRows.slice(0, 100), row_count: 250 },
          error: null,
        };
      }
      if (fn === 'ca_club_game_page') {
        expect(args).toEqual(
          expect.objectContaining({
            p_sort: 'recent',
            p_limit: 100,
            p_cursor: expect.objectContaining({ kind: 'CASH', id: 'recent-game-100' }),
          })
        );
        return new Promise((resolve) => {
          resolvePrefetch = resolve;
        });
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);

    const loadMore = await screen.findByRole('button', {
      name: 'Load More Games - 100 Of 250',
    });
    await waitFor(() => expect(resolvePrefetch).toBeTypeOf('function'));
    const pageCallsBeforeClick = rpcMock.mock.calls.filter(
      ([fn]) => fn === 'ca_club_game_page'
    ).length;
    fireEvent.click(loadMore);
    await screen.findByRole('button', { name: 'Loading More Games' });
    resolvePrefetch({
      data: {
        ...gamePage,
        rows: recentRows.slice(100),
        next_cursor: { value: 1, time: 1, kind: 'CASH', id: 'recent-game-200' },
        has_more: true,
        filtered_count: 250,
      },
      error: null,
    });

    await screen.findByRole('button', { name: 'Load More Games - 200 Of 250' });
    expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_game_page')).toHaveLength(
      pageCallsBeforeClick
    );
  });

  it('keeps an expanded recent ledger through the 60-second verified refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recentRows = Array.from({ length: 200 }, (_, index) => ({
      ...snapshot.rows[0],
      id: `heartbeat-game-${index + 1}`,
      name: `Heartbeat Game ${index + 1}`,
      started_at: new Date(Date.UTC(2026, 7, 30, 12, 0, 0) - index * 1_000).toISOString(),
    }));
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ca_club_data_snapshot') {
        return {
          data: { ...snapshot, rows: recentRows.slice(0, 100), row_count: 250 },
          error: null,
        };
      }
      if (fn === 'ca_club_game_page' && args?.p_sort === 'recent') {
        return {
          data: {
            ...gamePage,
            rows: recentRows.slice(100),
            next_cursor: { value: 1, time: 1, kind: 'CASH', id: 'heartbeat-game-200' },
            has_more: true,
            filtered_count: 250,
          },
          error: null,
        };
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    try {
      const { rerender } = render(<ClubDataPage />);
      const loadMore = await screen.findByRole('button', {
        name: 'Load More Games - 100 Of 250',
      });
      fireEvent.click(loadMore);
      await screen.findByRole('button', { name: 'Load More Games - 200 Of 250' });

      // IdentityDNA replaces the same signed-in user's object when delayed
      // profile hydration or a token refresh lands. That is not a new ledger
      // query and must not turn a background identity update into a destructive
      // first-page reload.
      authState.current = { user: { id: 'owner-1' }, isHydrating: false };
      rerender(<ClubDataPage />);
      await screen.findByRole('button', { name: 'Load More Games - 200 Of 250' });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      await screen.findByRole('button', { name: 'Load More Games - 200 Of 250' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires stale game pagination when a sort establishes a new cursor', async () => {
    const recentRows = Array.from({ length: 200 }, (_, index) => ({
      ...snapshot.rows[0],
      id: `recent-race-${index + 1}`,
      name: `Recent Race ${index + 1}`,
      started_at: new Date(Date.UTC(2026, 7, 30, 12, 0, 0) - index * 1_000).toISOString(),
    }));
    const rankedRows = Array.from({ length: 200 }, (_, index) => ({
      ...snapshot.rows[0],
      id: `ranked-race-${index + 1}`,
      name: `Ranked Race ${index + 1}`,
      fee: 10_000 - index,
    }));
    let resolveRecent!: (result: { data: Record<string, unknown>; error: null }) => void;
    let resolveRanked!: (result: { data: Record<string, unknown>; error: null }) => void;
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ca_club_data_snapshot') {
        return {
          data: { ...snapshot, rows: recentRows.slice(0, 100), row_count: 250 },
          error: null,
        };
      }
      if (fn === 'ca_club_game_page' && args?.p_sort === 'recent') {
        return new Promise((resolve) => {
          resolveRecent = resolve;
        });
      }
      if (fn === 'ca_club_game_page' && args?.p_sort === 'fee') {
        return new Promise((resolve) => {
          resolveRanked = resolve;
        });
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);

    const recentLoadMore = await screen.findByRole('button', {
      name: 'Load More Games - 100 Of 250',
    });
    await waitFor(() => expect(resolveRecent).toBeTypeOf('function'));
    fireEvent.click(recentLoadMore);
    await screen.findByRole('button', { name: 'Loading More Games' });

    fireEvent.click(screen.getByRole('button', { name: 'Highest Fee' }));
    await waitFor(() => expect(resolveRanked).toBeTypeOf('function'));
    expect(screen.getByRole('button', { name: 'Load More Games - 100 Of 250' })).toBeDisabled();

    act(() => {
      resolveRanked({
        data: {
          ...gamePage,
          rows: rankedRows,
          next_cursor: { value: 9_801, time: 1, kind: 'CASH', id: 'ranked-race-200' },
          has_more: true,
          filtered_count: 250,
        },
        error: null,
      });
      resolveRecent({
        data: {
          ...gamePage,
          rows: recentRows.slice(100),
          next_cursor: { value: 1, time: 1, kind: 'CASH', id: 'recent-race-200' },
          has_more: true,
          filtered_count: 250,
        },
        error: null,
      });
    });

    const rankedLoadMore = await screen.findByRole('button', {
      name: 'Load More Games - 100 Of 250',
    });
    await waitFor(() => expect(rankedLoadMore).toBeEnabled());
    fireEvent.click(rankedLoadMore);
    await screen.findByRole('button', { name: 'Load More Games - 200 Of 250' });
  });

  it('retires stale player pagination when a sort establishes a new cursor', async () => {
    const playerRows = Array.from({ length: 200 }, (_, index) => ({
      ...playerBreakdown.players[0],
      user_id: `player-race-${index + 1}`,
      username: `Player Race ${index + 1}`,
      net: 1_000 - index,
    }));
    let resolveOldPage!: (result: { data: Record<string, unknown>; error: null }) => void;
    let resolveLosers!: (result: { data: Record<string, unknown>; error: null }) => void;
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
      if (fn === 'ca_club_game_page') return { data: gamePage, error: null };
      if (fn === 'ca_club_player_breakdown') {
        return {
          data: { ...playerBreakdown, players: [], player_count: 250 },
          error: null,
        };
      }
      if (fn === 'ca_club_player_page' && args?.p_cursor) {
        return new Promise((resolve) => {
          resolveOldPage = resolve;
        });
      }
      if (fn === 'ca_club_player_page' && args?.p_sort === 'losers') {
        return new Promise((resolve) => {
          resolveLosers = resolve;
        });
      }
      if (fn === 'ca_club_player_page') {
        return {
          data: {
            ...playerPage,
            rows: playerRows.slice(0, 100),
            next_cursor: { value: 901, id: 'player-race-100' },
            has_more: true,
            filtered_count: 250,
          },
          error: null,
        };
      }
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    });

    render(<ClubDataPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Players' }));

    const loadMore = await screen.findByRole('button', {
      name: 'Load More Players - 100 Of 250',
    });
    fireEvent.click(loadMore);
    await waitFor(() => expect(resolveOldPage).toBeTypeOf('function'));
    await screen.findByRole('button', { name: 'Loading More Players' });

    fireEvent.click(screen.getByRole('button', { name: 'Biggest Losers' }));
    await waitFor(() => expect(resolveLosers).toBeTypeOf('function'));
    act(() => {
      resolveLosers({
        data: {
          ...playerPage,
          rows: playerRows.slice(0, 100).reverse(),
          next_cursor: { value: 901, id: 'player-race-1' },
          has_more: true,
          filtered_count: 250,
        },
        error: null,
      });
      resolveOldPage({
        data: {
          ...playerPage,
          rows: playerRows.slice(100),
          next_cursor: { value: 801, id: 'player-race-200' },
          has_more: true,
          filtered_count: 250,
        },
        error: null,
      });
    });

    const sortedLoadMore = await screen.findByRole('button', {
      name: 'Load More Players - 100 Of 250',
    });
    await waitFor(() => expect(sortedLoadMore).toBeEnabled());
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
