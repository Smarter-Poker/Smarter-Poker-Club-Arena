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
import { render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  page: null as any,
  buckets: [] as (number | null)[],
  extraCalls: [] as string[],
}));

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
    /*
       Models the server, which is where the filtering now lives: the tab is a
       QUERY. A mock that ignored the bucket and returned everything would let
       a client-side filter pass this suite while the real board showed the
       wrong tab's games.
    */
    list: async (
      _scope: string,
      _scopeId: string,
      _cursor: unknown = null,
      bucket: number | null = null
    ) => {
      mocks.buckets.push(bucket);
      return {
        ...mocks.page,
        items:
          bucket === null
            ? mocks.page.items
            : mocks.page.items.filter((row: any) => row.bucket === bucket),
      };
    },
    getContracts: async () => {
      mocks.extraCalls.push('getContracts');
      return [];
    },
    getCommandReceipts: async () => {
      mocks.extraCalls.push('getCommandReceipts');
      return [];
    },
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
    mocks.buckets = [];
    mocks.extraCalls = [];
  });

  /**
   * Drawing the board used to take five sequential round trips, about eleven
   * seconds against production. Four of them were this wave: contracts and
   * command receipts, twice each, and every one of them could only start after
   * the list came back because it needed the ids.
   *
   * fn_list_managed_games returns each row's contract and latest receipt inline
   * now, so the wave is gone. Pinned as an ABSENCE because that is the property
   * - re-adding a dependent per-row fetch is exactly the regression, and it
   * would not show up in any assertion about what the board renders.
   */
  it('draws the board without a second round trip per game', async () => {
    await renderBoard();
    expect(mocks.extraCalls, 'the board row must arrive whole').toEqual([]);
    expect(screen.getByText('Friday Deep Stack')).toBeInTheDocument();
  });

  /**
   * The mechanism, pinned separately from its effects.
   *
   * The tabs used to filter `games` in the page. That is invisible to a test
   * whose fixture happens to contain a row of every bucket - which is exactly
   * why the real regression shipped. Asserting that the SERVER is asked for the
   * tab's bucket is the thing that cannot pass while the filtering is local.
   */
  it('asks the server for the tab, rather than filtering what it already has', async () => {
    await renderBoard();
    expect(mocks.buckets, 'the All tab must not restrict the bucket').toEqual([null]);

    await clickTab('scheduled');
    expect(mocks.buckets.at(-1), 'the Scheduled tab must query bucket 1').toBe(1);

    await clickTab('closed');
    expect(mocks.buckets.at(-1), 'the Closed tab must query bucket 2').toBe(2);

    await clickTab('running');
    expect(mocks.buckets.at(-1), 'the Running tab must query bucket 0').toBe(0);
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

  /**
   * Open, Pause, Schedule and Close were all gated on the game being unfinished
   * and Edit was not, so a closed game could be renamed and re-limited from the
   * board. Nothing downstream refused it either: fn_update_managed_game never
   * looks at a table's status. A closed game is history and is read-only here.
   */
  it('does not offer Edit on a finished game', async () => {
    await renderBoard();
    await clickTab('closed');

    // Climb from the game's name to the ancestor that actually carries its
    // action row, rather than guessing a tag name for the card.
    let card: HTMLElement | null = screen.getByText('Tuesday Deepstack');
    while (card && card.querySelectorAll('button').length === 0) {
      card = card.parentElement;
    }
    expect(card, 'no action row found for the closed game').toBeTruthy();
    const labels = within(card as HTMLElement)
      .queryAllByRole('button')
      .map((b) => b.textContent?.trim().toLowerCase());
    expect(labels).not.toContain('edit');
    // Contract is history and stays reachable, so this is not "no buttons".
    expect(labels).toContain('contract');
  });
});
