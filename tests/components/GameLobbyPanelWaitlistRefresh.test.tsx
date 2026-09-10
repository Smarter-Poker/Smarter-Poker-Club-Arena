import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WaitlistEntry } from '../../src/services/WaitlistService';

const mocks = vi.hoisted(() => ({
  waitlist: vi.fn(),
  averagePot: vi.fn(async () => null),
}));
vi.mock('../../src/services/WaitlistService', () => ({
  waitlistService: { getTableWaitlist: mocks.waitlist },
}));
vi.mock('../../src/services/TableService', () => ({
  tableService: { getAveragePot: mocks.averagePot },
}));
vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: { getTournament: vi.fn(async () => null) },
}));
vi.mock('../../src/components/lobby/game-cards/ArenaGameCard', () => ({
  default: () => null,
}));
import GameLobbyPanel from '../../src/components/lobby/GameLobbyPanel';
import { cashEntry } from '../../src/components/lobby/lobbyEntries';

const entry = cashEntry({
  id: 'cash-table',
  name: 'Waitlist Test',
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 40,
  max_buy_in: 200,
  current_players: 6,
  max_players: 6,
  status: 'active',
});
const queued = {
  id: 'queue-row',
  tableId: entry.id,
  userId: 'hero',
  status: 'waiting',
  createdAt: '2026-09-10T00:00:00Z',
  joinedAt: '2026-09-10T00:00:00Z',
  notifiedAt: null,
  position: 1,
  tableName: entry.name,
  displayName: 'Hero',
  holdExpiresAt: null,
} satisfies WaitlistEntry;
const callbacks = {
  onClose: vi.fn(),
  onJoinTable: vi.fn(),
  onWaitlistToggle: vi.fn(),
  onRegister: vi.fn(),
  onUnregister: vi.fn(),
  onSpinJoin: vi.fn(),
};

function drawer(waitlisted: boolean, busy = false) {
  return (
    <MemoryRouter>
      <GameLobbyPanel
        entry={entry}
        clubId="club"
        currentUserId="hero"
        waitlisted={waitlisted}
        busy={busy}
        seated={false}
        registered={false}
        {...callbacks}
      />
    </MemoryRouter>
  );
}
const waitingCount = () => screen.getByText('Waiting', { exact: true }).nextElementSibling;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.waitlist.mockReset();
});

describe('the open game drawer follows a settled waitlist change', () => {
  it.each([false, true])(
    'refreshes after a successful %s membership change',
    async (wasWaitlisted) => {
      const before = wasWaitlisted ? [queued] : [];
      const after = wasWaitlisted ? [] : [queued];
      mocks.waitlist.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      const view = render(drawer(wasWaitlisted));
      await waitFor(() => expect(waitingCount()).toHaveTextContent(String(before.length)));
      await act(async () => {});
      view.rerender(drawer(!wasWaitlisted, true));
      expect(mocks.waitlist).toHaveBeenCalledTimes(1);
      expect(waitingCount()).toHaveTextContent(String(before.length));
      view.rerender(drawer(!wasWaitlisted, false));
      await waitFor(() => expect(waitingCount()).toHaveTextContent(String(after.length)));
      expect(mocks.waitlist).toHaveBeenCalledTimes(2);
      expect(mocks.averagePot).toHaveBeenCalledTimes(1);
      if (wasWaitlisted) expect(screen.queryByText('You', { exact: true })).toBeNull();
      else expect(screen.getByText('You', { exact: true })).toBeInTheDocument();
    }
  );

  it('keeps the confirmed queue when an optimistic leave is refused', async () => {
    mocks.waitlist.mockResolvedValue([queued]);
    const view = render(drawer(true));
    await waitFor(() => expect(waitingCount()).toHaveTextContent('1'));
    view.rerender(drawer(false, true));
    view.rerender(drawer(true, false));
    await act(async () => {});
    expect(waitingCount()).toHaveTextContent('1');
    expect(screen.getByText('You', { exact: true })).toBeInTheDocument();
    expect(mocks.waitlist).toHaveBeenCalledTimes(1);
  });

  it('retries an initial read retired by a pending action', async () => {
    let finishInitial!: (rows: WaitlistEntry[]) => void;
    mocks.waitlist
      .mockReturnValueOnce(
        new Promise<WaitlistEntry[]>((resolve) => {
          finishInitial = resolve;
        })
      )
      .mockResolvedValueOnce([queued]);
    const view = render(drawer(true));
    view.rerender(drawer(false, true));
    await act(async () => finishInitial([]));
    view.rerender(drawer(true, false));
    await waitFor(() => expect(waitingCount()).toHaveTextContent('1'));
    expect(mocks.waitlist).toHaveBeenCalledTimes(2);
  });

  it('shows an unknown queue if the settled-change refresh fails', async () => {
    mocks.waitlist.mockResolvedValueOnce([queued]).mockResolvedValueOnce(null);
    const view = render(drawer(true));
    await waitFor(() => expect(waitingCount()).toHaveTextContent('1'));
    view.rerender(drawer(false, true));
    view.rerender(drawer(false, false));
    await waitFor(() => expect(waitingCount()).toHaveTextContent('-'));
    expect(screen.queryByText('You', { exact: true })).toBeNull();
    mocks.waitlist.mockResolvedValueOnce([queued]);
    view.rerender(drawer(true, true));
    view.rerender(drawer(true, false));
    await waitFor(() => expect(waitingCount()).toHaveTextContent('1'));
    expect(mocks.waitlist).toHaveBeenCalledTimes(3);
  });
});
