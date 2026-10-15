import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const { rpcMock, authState } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  authState: { current: { user: { id: 'owner-1' }, isHydrating: false } as any },
}));

vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => authState.current }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ clubId: CLUB_ID }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import ClubDataSimplePage, {
  addDays,
  formatMoney,
  formatTotal,
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
      expect(screen.getByText('Club Data Could Not Be Read. Showing The Last Good Figures.')).toBeTruthy()
    );
    expect(screen.getByText('987.25')).toBeTruthy();
  });

  it('tells a viewer without finance rights why, instead of showing zeros', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'not authorized for this club' },
    });
    render(<ClubDataSimplePage />);
    expect(
      await screen.findByText('Only The Club Owner, Admins And Super Agents Can View Club Data.')
    ).toBeTruthy();
    expect(screen.queryByText('0.00')).toBeNull();
  });
});
