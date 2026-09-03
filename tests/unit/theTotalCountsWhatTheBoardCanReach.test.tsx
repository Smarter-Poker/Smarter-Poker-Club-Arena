/**
 * The header's Total must be a number the operator can arrive at.
 *
 * The board's ROWS honour a closed-games horizon: a table that finished three
 * weeks ago is not listed. The COUNTS did not - they summarised the whole
 * scope. On Midway Union that read
 *
 *     208 Live    80 Scheduled    79,142 Total
 *
 * while paging every tab to exhaustion yields 35,745. The header promised
 * forty-three thousand games the board will never hand over, and the pager
 * said "Load More - 50 Of 79142", counting towards a number no amount of
 * clicking reaches. On the Closed tab it was worse: the same whole-scope total
 * next to a page of closed games only.
 *
 * A total nobody can reconcile is worse than no total: it reads as data loss.
 *
 * Live and scheduled games are never withheld by age - an old scheduled
 * tournament is still the operator's problem - so only the closed leg is
 * horizon-bound, and the reachable total is live + scheduled + closed-within-
 * horizon. The games beyond the horizon are not hidden, they are explained.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ counts: null as any, holdList: false }));

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
            data: { id: 'club-uuid-1', name: 'Midway Union' },
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
    list: async (
      _scope: string,
      _scopeId: string,
      _cursor: unknown = null,
      bucket: number | null = null
    ) => {
      if (mocks.holdList) await new Promise(() => {});
      return {
        items: [
          {
            id: 'g1',
            kind: 'table',
            name: 'Friday Deep Stack',
            status: bucket === 2 ? 'closed' : 'running',
            club_id: 'club-uuid-1',
            players: 0,
            max_players: 9,
            bucket: bucket ?? 0,
          },
        ],
        counts: mocks.counts,
        // A cursor, so the pager renders and can be read.
        nextCursor: {
          sortAt: '2026-09-01T00:00:00Z',
          kind: 'table',
          id: 'g1',
          bucket: bucket ?? 0,
        },
      };
    },
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

/** Midway Union, as production actually reported it. */
const MIDWAY = {
  total: 79142,
  live: 208,
  scheduled: 80,
  closed: 78854,
  closedWithinHorizon: 35457,
  closedHorizonDays: 7,
};
const REACHABLE = MIDWAY.live + MIDWAY.scheduled + MIDWAY.closedWithinHorizon; // 35,745

const renderBoard = async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/midway-union/table-management']}>
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

const pagerText = () =>
  screen.getAllByRole('button').find((b) => b.textContent?.startsWith('Load More'))?.textContent ??
  '';

describe('the total counts what the board can reach', () => {
  beforeEach(() => {
    mocks.counts = MIDWAY;
    mocks.holdList = false;
  });

  it('shows the reachable total, not the whole archive', async () => {
    await renderBoard();
    expect(screen.getByText(String(REACHABLE))).toBeInTheDocument();
    expect(
      screen.queryByText(String(MIDWAY.total)),
      'the unreachable total must not be shown'
    ).toBeNull();
  });

  /**
   * The horizon is not a secret. Hiding 43,397 games AND the fact that they
   * exist would trade a confusing number for a missing one.
   */
  it('explains the games beyond the horizon rather than hiding them', async () => {
    await renderBoard();
    const total = screen.getByText(String(REACHABLE)).closest('span');
    expect(total?.getAttribute('title')).toContain(
      String(MIDWAY.closed - MIDWAY.closedWithinHorizon)
    );
    expect(total?.getAttribute('title')).toContain(String(MIDWAY.closedHorizonDays));
  });

  /**
   * The pager counts towards the tab it is paging. "50 Of 79142" under a page
   * of closed games was wrong twice: the wrong scope AND the wrong tab.
   */
  it('counts the pager towards the open tab', async () => {
    await renderBoard();
    expect(pagerText()).toContain(String(REACHABLE));

    await clickTab('running');
    expect(pagerText()).toContain(String(MIDWAY.live));

    await clickTab('scheduled');
    expect(pagerText()).toContain(String(MIDWAY.scheduled));

    await clickTab('closed');
    expect(pagerText()).toContain(String(MIDWAY.closedWithinHorizon));
    expect(pagerText(), 'the Closed tab must not count the archive').not.toContain(
      String(MIDWAY.closed)
    );
  });

  /**
   * A club whose whole history fits inside the horizon must read exactly as
   * before - the fix must not invent a discrepancy where there is none. Deep
   * Stack Society: 1,814 games, all 1,507 closed ones within seven days.
   */
  it('is unchanged when nothing is beyond the horizon', async () => {
    mocks.counts = {
      total: 1814,
      live: 271,
      scheduled: 36,
      closed: 1507,
      closedWithinHorizon: 1507,
      closedHorizonDays: 7,
    };
    await renderBoard();
    expect(screen.getByText('1814')).toBeInTheDocument();
    const total = screen.getByText('1814').closest('span');
    expect(total?.getAttribute('title')).toMatch(/every game in this scope is on the board/i);
  });
  /**
   * Found reviewing my own change, before calling it done.
   *
   * `counts` starts as a zero-filled object and this rail renders as soon as
   * ACCESS resolves - which is before the first list has come back. For the
   * length of that first load every figure in the rail is a placeholder. The
   * numbers can live with that; a zero beside the word Live reads as
   * "counting". The tooltip could not: "Every Game In This Scope Is On The
   * Board" is a sentence, and a sentence reads as an answer. It was being
   * asserted about a scope nothing had read yet.
   *
   * Exactly the failure the health rail's `?? 0` had, introduced in the same
   * breath as the fix for it, which is the reason this test exists.
   */
  it('claims nothing about the horizon before the first read returns', async () => {
    mocks.holdList = true;
    render(
      <MemoryRouter initialEntries={['/clubs/midway-union/table-management']}>
        <Routes>
          <Route
            path="/clubs/:clubId/table-management"
            element={<GameManagementPage scope="club" />}
          />
        </Routes>
      </MemoryRouter>
    );
    // The rail is up (access resolved); the list has not answered.
    const total = await screen.findByText('Total');
    expect(total.closest('span')?.getAttribute('title')).toBeNull();
  });
  /**
   * A counts object with a hole in it must not render "NaN" on an operator
   * console. The service normalises every field, so production cannot reach
   * this - but the sum is the only place on the page that adds three counts
   * together, and three existing fixtures that predate closedWithinHorizon
   * were rendering exactly that in the test output. A warning nobody reads is
   * still the code telling you something.
   */
  it('treats a missing count as zero rather than rendering NaN', async () => {
    mocks.counts = { total: 9, live: 5, scheduled: 4 } as any;
    await renderBoard();
    // 5 live + 4 scheduled + a missing closed leg = 9 reachable, not NaN.
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.queryByText('NaN')).toBeNull();
  });
});
