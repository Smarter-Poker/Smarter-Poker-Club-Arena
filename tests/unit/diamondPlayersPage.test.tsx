/**
 * The Diamond Arena's Players page (src/pages/DiamondPlayersPage.tsx) and the
 * door that chooses it (src/pages/ClubPlayersDoor.tsx).
 *
 * Phase 10, line 3: the four figures show loading, a real zero and "could not
 * tell" as three different things. Line 6, the Players-page half: none of the
 * chip roster's agent, admin, downline, fee, wallet or export machinery, and
 * no "approved members only" refusal. A chip club still gets the chip roster.
 */
import '@testing-library/jest-dom/vitest';
import { Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNT_UNKNOWN } from '../../src/lib/countFigure';
import { DIAMOND_ONLINE_RECHECK_MS } from '../../src/lib/diamondArenaCounts';

const state = vi.hoisted(() => ({
  getCounts: vi.fn(),
  getRosterPage: vi.fn(),
  automatic: false,
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/DiamondArenaRosterService', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/DiamondArenaRosterService')
  >('../../src/services/DiamondArenaRosterService');
  return {
    ...actual,
    default: { getCounts: state.getCounts, getRosterPage: state.getRosterPage },
  };
});
vi.mock('../../src/components/arena/arenaAccess', () => ({
  useAutomaticArenaMembership: () => state.automatic,
}));
vi.mock('../../src/pages/ClubMembersPage', () => ({
  default: () => <div>Chip Club Roster</div>,
}));

import DiamondPlayersPage from '../../src/pages/DiamondPlayersPage';
import ClubPlayersDoor from '../../src/pages/ClubPlayersDoor';

const PLAYERS = [
  {
    user_id: 'u-1',
    alias: 'River Rat',
    username: 'riverrat',
    avatar_url: null,
    player_number: '100231',
    is_seated: false,
    is_online: false,
  },
  {
    user_id: 'u-2',
    alias: 'Nit Wit',
    username: 'nitwit',
    avatar_url: null,
    player_number: null,
    is_seated: false,
    is_online: false,
  },
];

const figure = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).parentElement?.querySelector('dd')?.textContent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  state.getCounts.mockReset();
  state.getRosterPage.mockReset();
  state.automatic = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the Diamond Arena Players page', () => {
  it('shows loading, then real figures, a real zero, and Unavailable for what it could not tell', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const counts = deferred<Record<string, unknown>>();
    state.getCounts.mockReturnValue(counts.promise);
    state.getRosterPage.mockResolvedValue({
      items: PLAYERS,
      next_cursor: null,
      has_more: false,
      filtered_total: 2,
    });
    render(<DiamondPlayersPage />);

    for (const label of ['Members', 'Online Now', 'At Tables', 'Tables']) {
      expect(figure(label), `${label} while loading`).toBe('...');
    }
    expect(screen.getByText('Counting The Arena.')).toBeInTheDocument();

    counts.resolve({ members: 1149, online: COUNT_UNKNOWN, seated: 0, tables: 17 });
    await waitFor(() => expect(figure('Members')).toBe((1149).toLocaleString()));
    expect(figure('Online Now'), 'an unknown Online is asked once more first').toBe('...');
    expect(state.getCounts).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIAMOND_ONLINE_RECHECK_MS);
    });
    await waitFor(() => expect(figure('Online Now')).toBe('Unavailable'));
    expect(state.getCounts).toHaveBeenCalledTimes(2);
    expect(figure('Members')).toBe((1149).toLocaleString());
    expect(figure('At Tables'), 'nobody seated is a real zero').toBe('0');
    expect(figure('Tables')).toBe('17');
    expect(
      screen.getByText('Unavailable Means The Arena Could Not Tell, Not That The Figure Is Zero.')
    ).toBeInTheDocument();

    expect(await screen.findByText('River Rat')).toBeInTheDocument();
    expect(screen.getByText('Nit Wit')).toBeInTheDocument();
    expect(screen.getByText('2 Results')).toBeInTheDocument();
    expect(state.getRosterPage).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'all', search: '' })
    );
  });

  it('asks Online once more, since a cold load can ask before its own live feeds register', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.getCounts
      .mockResolvedValueOnce({ members: 2, online: COUNT_UNKNOWN, seated: 0, tables: 17 })
      .mockResolvedValueOnce({ members: 3, online: 1, seated: 1, tables: 18 });
    state.getRosterPage.mockResolvedValue({
      items: PLAYERS,
      next_cursor: null,
      has_more: false,
      filtered_total: 2,
    });
    render(<DiamondPlayersPage />);

    await waitFor(() => expect(figure('Members')).toBe('2'));
    expect(figure('Online Now')).toBe('...');
    expect(screen.queryByText(/Unavailable Means/)).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIAMOND_ONLINE_RECHECK_MS);
    });
    await waitFor(() => expect(figure('Online Now')).toBe('1'));
    expect(state.getCounts).toHaveBeenCalledTimes(2);
    expect(figure('Members'), 'the second answer changes Online alone').toBe('2');
    expect(figure('At Tables')).toBe('0');
    expect(figure('Tables')).toBe('17');
    expect(screen.queryByText(/Unavailable Means/)).not.toBeInTheDocument();
  });

  it('a known Online is not asked again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.getCounts.mockResolvedValue({ members: 2, online: 0, seated: 0, tables: 17 });
    state.getRosterPage.mockResolvedValue({
      items: PLAYERS,
      next_cursor: null,
      has_more: false,
      filtered_total: 2,
    });
    render(<DiamondPlayersPage />);
    await waitFor(() => expect(figure('Online Now'), 'a real zero').toBe('0'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIAMOND_ONLINE_RECHECK_MS * 2);
    });
    expect(state.getCounts).toHaveBeenCalledTimes(1);
  });

  it('a failed read says Unavailable everywhere and that the players could not load, never 0', async () => {
    state.getCounts.mockRejectedValue(new Error('offline'));
    state.getRosterPage.mockRejectedValue(new Error('offline'));
    render(<DiamondPlayersPage />);

    expect(await screen.findByText('Could Not Load The Players.')).toBeInTheDocument();
    await waitFor(() => expect(figure('Members')).toBe('Unavailable'));
    for (const label of ['Online Now', 'At Tables', 'Tables']) {
      expect(figure(label)).toBe('Unavailable');
    }
    expect(
      screen.getByText('The Arena Totals Could Not Be Read. Refresh To Try Again.')
    ).toBeInTheDocument();
    expect(screen.queryByText('0 Results')).not.toBeInTheDocument();
  });

  it('carries none of the chip roster: no agent, admin, downline, fee, wallet or export view', async () => {
    state.getCounts.mockResolvedValue({ members: 2, online: 0, seated: 0, tables: 17 });
    state.getRosterPage.mockResolvedValue({
      items: PLAYERS,
      next_cursor: null,
      has_more: false,
      filtered_total: 2,
    });
    const { container } = render(<DiamondPlayersPage />);
    await screen.findByText('River Rat');

    const views = screen.getByRole('group', { name: 'Player Views' }).querySelectorAll('button');
    expect([...views].map((button) => button.textContent)).toEqual(['All Players', 'At Tables']);
    const text = container.textContent ?? '';
    for (const chip of [
      'My Downline',
      'Agents',
      'Admins',
      'Downline',
      'Fees',
      'Wallet',
      'Export',
      'Upline',
      'Role Hierarchy',
      'Approved Club Members',
      'Horse',
    ]) {
      expect(text, `the Diamond Players page must not show "${chip}"`).not.toContain(chip);
    }
    expect(container.querySelector('select'), 'no chip sort menu').toBeNull();
    expect(container.querySelector('input[type="checkbox"]'), 'no selection or columns').toBeNull();
  });

  it('the At Tables view with nobody seated is a real, named zero', async () => {
    state.getCounts.mockResolvedValue({ members: 2, online: 0, seated: 0, tables: 17 });
    state.getRosterPage.mockImplementation(async ({ filter }: { filter: string }) =>
      filter === 'seated'
        ? { items: [], next_cursor: null, has_more: false, filtered_total: 0 }
        : { items: PLAYERS, next_cursor: null, has_more: false, filtered_total: 2 }
    );
    render(<DiamondPlayersPage />);
    await screen.findByText('River Rat');

    fireEvent.click(screen.getByRole('button', { name: 'At Tables' }));
    expect(await screen.findByText('No Players At Tables')).toBeInTheDocument();
    expect(screen.getByText('No One Is Seated At A Diamond Table Right Now.')).toBeInTheDocument();
    expect(screen.getByText('0 Results')).toBeInTheDocument();
  });
});

describe('the Players door', () => {
  it('a chip club gets the chip roster', () => {
    state.automatic = false;
    render(<ClubPlayersDoor />);
    expect(screen.getByText('Chip Club Roster')).toBeInTheDocument();
    expect(state.getCounts).not.toHaveBeenCalled();
  });

  it('the Diamond Arena gets its own Players page', async () => {
    state.automatic = true;
    state.getCounts.mockResolvedValue({ members: 2, online: null, seated: 0, tables: 17 });
    state.getRosterPage.mockResolvedValue({
      items: PLAYERS,
      next_cursor: null,
      has_more: false,
      filtered_total: 2,
    });
    render(
      <Suspense fallback={<div>Loading Page</div>}>
        <ClubPlayersDoor />
      </Suspense>
    );
    expect(await screen.findByRole('heading', { name: 'Players' })).toBeInTheDocument();
    expect(screen.queryByText('Chip Club Roster')).not.toBeInTheDocument();
    expect(await screen.findByText('River Rat')).toBeInTheDocument();
  });
});
