import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const { rpcMock, authState, clubRow, unionRow } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  unionRow: {
    current: { unions: { name: 'Midway Union' } } as { unions: { name: string } } | null,
  },
  clubRow: { current: { name: 'Club JAQK' } as { name: string } | null },
  authState: { current: { user: { id: 'owner-1' }, isHydrating: false } as any },
}));

vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => authState.current }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ clubId: CLUB_ID }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === 'union_clubs' ? unionRow.current : clubRow.current,
            error: null,
          }),
        }),
      }),
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import ClubDataSimplePage, {
  addDays,
  formatMoney,
  formatTotal,
  headerTitle,
  isSnapshot,
  refreshIntervalMs,
} from '../../src/pages/club/ClubDataSimplePage';

const today = new Date().toISOString().slice(0, 10);

const live = {
  range: { start: today, end: today, days: 1 },
  summary: {
    games: 3,
    total_winnings: -1234.5,
    mtt_winnings: 210,
    cash_winnings: -1444.5,
    fee: 987.25,
    on_felt: 5400,
  },
  rows: [
    {
      kind: 'CASH',
      id: 'table-1',
      name: 'Shark Tank',
      variant: 'NLH',
      blinds: '1/2',
      started_at: `${today}T00:10:00Z`,
      fee: 50,
      winnings: -50,
      players: 6,
      live: true,
      seated: 5,
      on_felt: 900,
    },
  ],
  generated_at: `${today}T00:30:00Z`,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  rpcMock.mockReset();
  clubRow.current = { name: 'Club JAQK' };
  unionRow.current = { unions: { name: 'Midway Union' } };
  authState.current = { user: { id: 'owner-1' }, isHydrating: false };
});

describe('helpers', () => {
  it('formats money with two decimals and a dash for nothing', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50');
    expect(formatMoney(-0.1)).toBe('-0.10');
    expect(formatMoney(undefined)).toBe('-');
  });

  it('steps UTC days without drifting across a month', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-10-14', 0)).toBe('2026-10-14');
  });

  it('fits a large total in its tile without losing the exact figure', () => {
    expect(formatTotal(9_999.5)).toBe('9,999.50');
    expect(formatTotal(149_602.37)).toBe('149.6K');
    expect(formatTotal(-55_668.2)).toBe('-55.6K');
    expect(formatTotal(3_544_599.22)).toBe('3.54M');
    expect(formatTotal(undefined)).toBe('-');
  });

  it('refreshes faster on the live day', () => {
    expect(refreshIntervalMs(1)).toBe(15_000);
    expect(refreshIntervalMs(14)).toBe(60_000);
  });

  it('refuses a payload without the four totals', () => {
    expect(isSnapshot(live)).toBe(true);
    expect(isSnapshot({ range: {}, summary: { games: 1 }, rows: [] })).toBe(false);
    expect(isSnapshot(null)).toBe(false);
  });
});

describe('ClubDataSimplePage', () => {
  it('attributes games to the union even when the creator is missing or named', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...live,
        rows: [
          { ...live.rows[0], creator_name: 'kingfish' },
          { ...live.rows[0], id: 'table-2', creator_name: null },
        ],
      },
      error: null,
    });
    render(<ClubDataSimplePage />);
    await waitFor(() => expect(screen.getAllByText('By Midway Union')).toHaveLength(2));
    expect(screen.queryByText(/kingfish/i)).toBeNull();
  });

  it('uses the club name when there is no hosting union, never the creator', async () => {
    unionRow.current = null;
    rpcMock.mockResolvedValue({
      data: { ...live, rows: [{ ...live.rows[0], creator_name: 'kingfish' }] },
      error: null,
    });
    render(<ClubDataSimplePage />);
    expect(await screen.findByText('By Club JAQK')).toBeTruthy();
    expect(screen.queryByText(/kingfish/i)).toBeNull();
  });

  it('counts all live games beyond the 200 displayed rows', async () => {
    rpcMock.mockResolvedValue({
      data: { ...live, summary: { ...live.summary, live_games: 245 } },
      error: null,
    });
    render(<ClubDataSimplePage />);
    expect(await screen.findByText(/245 Games In Play/)).toBeTruthy();
  });

  it('shows the four live totals and a live game', async () => {
    rpcMock.mockResolvedValue({ data: live, error: null });
    render(<ClubDataSimplePage />);
    expect(await screen.findByText('987.25')).toBeTruthy();
    expect(screen.getByText('-1,234.50')).toBeTruthy();
    expect(screen.getByText('210.00')).toBeTruthy();
    expect(screen.getByText('Shark Tank')).toBeTruthy();
    expect(screen.getByText('Live', { selector: 'span' })).toBeTruthy();
    const [fn, args] = rpcMock.mock.calls[0];
    expect(fn).toBe('ca_club_data_screen');
    expect(args).toMatchObject({ p_club_id: CLUB_ID, p_start: today, p_end: today, p_game: 'ALL' });
  });

  it('says there is no data only when the read succeeded and found none', async () => {
    rpcMock.mockResolvedValue({
      data: { ...live, summary: { ...live.summary, games: 0 }, rows: [] },
      error: null,
    });
    render(<ClubDataSimplePage />);
    expect(await screen.findByText('No Data In This Period.')).toBeTruthy();
  });

  it('keeps the last good figures when a refresh fails, and never paints zeros', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rpcMock.mockResolvedValueOnce({ data: live, error: null });
    rpcMock.mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } });
    render(<ClubDataSimplePage />);
    expect(await screen.findByText('987.25')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await waitFor(() =>
      expect(
        screen.getByText('Club Data Could Not Be Read. Showing The Last Good Figures.')
      ).toBeTruthy()
    );
    expect(screen.getByText('987.25')).toBeTruthy();
  });

  /* UPDATED 2026-10-17: agents of every rank now read their own downline
     (fn_ca_club_data_scope); a regular player is the one refused. */
  it('tells a viewer without finance rights why, instead of showing zeros', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'not authorized for this club' },
    });
    render(<ClubDataSimplePage />);
    expect(
      await screen.findByText('Club Data Is Open To The Club Owner, Admins And Agents.')
    ).toBeTruthy();
    expect(screen.queryByText('0.00')).toBeNull();
  });

  it('names the club next to Club Data: "CLUB JAQK - CLUB DATA"', async () => {
    rpcMock.mockResolvedValue({
      data: { ...live, club_name: 'Club JAQK', scope: 'club' },
      error: null,
    });
    render(<ClubDataSimplePage />);
    const title = await screen.findByRole('heading', { level: 1 });
    await waitFor(() =>
      expect(title.textContent?.replace(/\u00a0/g, ' ')).toBe('CLUB JAQK - CLUB DATA')
    );
    expect(title.getAttribute('title')).toBe('CLUB JAQK - CLUB DATA');
    expect(headerTitle(null)).toBe('Club Data');
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();
  });

  it('an agent reads his own downline, and has no whole-club report door', async () => {
    rpcMock.mockResolvedValue({
      data: { ...live, club_name: 'Club JAQK', scope: 'downline' },
      error: null,
    });
    render(<ClubDataSimplePage />);
    expect(await screen.findByText(/You And Your Downline/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
  });
});
