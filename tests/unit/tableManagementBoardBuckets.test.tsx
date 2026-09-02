/**
 * The board classifies games by the server's bucket, and only by that.
 *
 * Shipped bug, 2026-09-02. Deep Stack Society had 36 tournaments scheduled and
 * the Scheduled counter read 0, while the Scheduled tab showed nothing at all.
 *
 * Both the SQL and this page defined "scheduled" the same wrong way - a
 * tournament whose status is NOT in the live list and NOT in the closed list.
 * Every tournament in this system is REGISTERING until it ends, and
 * REGISTERING is in the LIVE list. No row could satisfy the definition, so the
 * counter was structurally zero and the tab was structurally empty. A
 * tournament starting in three days was being reported as live.
 *
 * The definition now lives once, in fn_list_managed_games, and arrives as a
 * bucket: 0 live, 1 scheduled, 2 closed. These tests pin that the page reads
 * it rather than re-deriving it, because re-deriving it is the bug.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ page: null as any }));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'operator-1' } }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
  useMasterBusSubscriptions: () => {},
}));
vi.mock('../../src/hooks/useGameManagementRealtime', () => ({
  useGameManagementRealtime: () => 'live',
  default: () => 'live',
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async () => 'club-uuid-1' }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: () => {} }));
vi.mock('../../src/services/GameAccessService', () => ({
  fetchGameCreationAccess: async () => ({ allowed: true, unionId: null, reason: 'ok' }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'club-uuid-1', name: 'Deep Stack Society' },
            error: null,
          }),
        }),
      }),
    }),
  },
}));
vi.mock('../../src/services/UnionService', () => ({
  unionService: { isUnionAdmin: async () => false },
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }),
}));
vi.mock('../../src/services/GameManagementService', () => ({
  gameManagementService: {
    list: async () => mocks.page,
    getContracts: async () => [],
    getCommandReceipts: async () => [],
    getHealth: async () => ({
      latestEventSequence: 0,
      lastEventAt: null,
      eventsLastHour: 0,
      commandsLast24h: 0,
      rejectedLast24h: 0,
      integrityAlerts: 0,
      scheduledPending: 0,
      scheduledRejected24h: 0,
      eventRows: 0,
      retentionDays: 30,
    }),
  },
}));

import GameManagementPage from '../../src/pages/GameManagementPage';

/**
 * The shape production actually returns: every tournament REGISTERING, one of
 * them starting later. Under the old rule all three counted as live.
 */
const PAGE = {
  items: [
    {
      id: 'tbl-live',
      kind: 'table',
      name: 'Friday Deep Stack',
      status: 'running',
      club_id: 'club-uuid-1',
      players: 6,
      max_players: 9,
      bucket: 0,
    },
    {
      id: 'trn-open',
      kind: 'tournament',
      name: 'Nightly Turbo',
      status: 'REGISTERING',
      club_id: 'club-uuid-1',
      players: 40,
      max_players: 200,
      bucket: 0,
    },
    {
      id: 'trn-future',
      kind: 'tournament',
      name: 'Sunday Major',
      status: 'REGISTERING',
      club_id: 'club-uuid-1',
      players: 3,
      max_players: 500,
      start_time: '2026-09-05T20:00:00Z',
      bucket: 1,
    },
    {
      id: 'trn-done',
      kind: 'tournament',
      name: 'Tuesday Deepstack',
      status: 'COMPLETED',
      club_id: 'club-uuid-1',
      players: 0,
      max_players: 200,
      bucket: 2,
    },
  ],
  counts: { total: 4, live: 2, scheduled: 1, closed: 1 },
  nextCursor: null,
};

const renderBoard = async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/deep-stack-society-11192/table-management']}>
      <Routes>
        <Route
          path="/clubs/:clubId/table-management"
          element={<GameManagementPage scope="club" />}
        />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.queryByText('Friday Deep Stack')).toBeInTheDocument());
};

const clickTab = async (label: string) => {
  const tab = screen
    .getAllByRole('button')
    .find((b) => b.textContent?.trim().toLowerCase() === label);
  expect(tab, `no "${label}" tab on the board`).toBeTruthy();
  await act(async () => tab!.click());
};

describe('the board classifies games by the server bucket', () => {
  beforeEach(() => {
    mocks.page = PAGE;
  });

  it('counts a tournament that has not started as scheduled, not live', async () => {
    await renderBoard();
    // The count rail renders `<strong>{n}</strong> Scheduled` in one <span>.
    // Scoped to that shape on purpose: the filter tabs also say "scheduled".
    const rail = screen
      .getAllByText(/Scheduled/)
      .map((n) => n.closest('span'))
      .find((n) => /^\d+ Scheduled$/.test(n?.textContent?.replace(/\s+/g, ' ').trim() || ''));
    expect(rail, 'no "<n> Scheduled" tile in the count rail').toBeTruthy();
    // The regression read "0 Scheduled" with three tournaments on the board.
    expect(rail!.textContent!.replace(/\s+/g, ' ').trim()).toBe('1 Scheduled');
  });

  it('shows the scheduled tournament on the Scheduled tab', async () => {
    await renderBoard();
    await clickTab('scheduled');
    expect(screen.getByText('Sunday Major')).toBeInTheDocument();
    // REGISTERING but already under way - live, not scheduled.
    expect(screen.queryByText('Nightly Turbo')).not.toBeInTheDocument();
    expect(screen.queryByText('Tuesday Deepstack')).not.toBeInTheDocument();
  });

  it('keeps a REGISTERING tournament that is under way on the running tab', async () => {
    await renderBoard();
    await clickTab('running');
    expect(screen.getByText('Nightly Turbo')).toBeInTheDocument();
    expect(screen.getByText('Friday Deep Stack')).toBeInTheDocument();
    expect(screen.queryByText('Sunday Major')).not.toBeInTheDocument();
  });

  it('keeps finished games on the closed tab and off the others', async () => {
    await renderBoard();
    await clickTab('closed');
    expect(screen.getByText('Tuesday Deepstack')).toBeInTheDocument();
    expect(screen.queryByText('Friday Deep Stack')).not.toBeInTheDocument();
  });
});
