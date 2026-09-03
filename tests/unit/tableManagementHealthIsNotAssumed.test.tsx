/**
 * A health read that FAILED must not be painted as a clean bill of health.
 *
 * Found 2026-09-03 on production, on the live board. The management health
 * rail read
 *
 *     0 COMMANDS / 24H   0 REJECTED   0 INTEGRITY ALERTS
 *     0 PENDING SCHEDULES   0 SCHEDULE REJECTS   0 REALTIME EVENTS
 *
 * while the database held 60,387 realtime events for that club in the same
 * 24 hours and fn_get_game_management_health returned events_last_hour 935.
 * The server was right; the page had asked and been refused (a 401 in the
 * console), and `getHealth` is deliberately wrapped in a `.catch` that
 * degrades to null so telemetry can never take the board down with it.
 *
 * That part is correct. What was wrong is what came next: every tile read
 * `health?.field ?? 0`, so "could not ask" and "asked, and the answer is zero"
 * rendered identically. On a console whose job is to tell an operator whether
 * anything is wrong, the failure direction was reassurance - "0 Integrity
 * Alerts" is exactly what a healthy floor looks like.
 *
 * It also self-corrected on the next load, which makes it worse rather than
 * better: the operator sees a number that is sometimes the truth and sometimes
 * an artifact of a failed request, with nothing to tell them which.
 *
 * These tests pin the distinction, not the wording of any one tile.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  health: null as any,
  healthThrows: false,
  healthCalls: 0,
  releaseHealth: null as null | (() => void),
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
    list: async () => ({
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
      ],
      counts: { total: 1, live: 1, scheduled: 0, closed: 0 },
      nextCursor: null,
    }),
    getContracts: async () => [],
    getCommandReceipts: async () => [],
    getHealth: async () => {
      mocks.healthCalls += 1;
      if (mocks.releaseHealth) {
        await new Promise<void>((resolve) => {
          mocks.releaseHealth = resolve;
        });
      }
      if (mocks.healthThrows) throw new Error('401');
      return mocks.health;
    },
  },
}));

import GameManagementPage from '../../src/pages/GameManagementPage';

const HEALTHY = {
  latestEventSequence: 803206,
  lastEventAt: '2026-09-03T16:15:27.183Z',
  eventsLastHour: 935,
  commandsLast24h: 0,
  rejectedLast24h: 0,
  integrityAlerts: 0,
  scheduledPending: 0,
  scheduledRejected24h: 0,
  eventRows: 259681,
  retentionDays: 30,
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

const healthRail = () => screen.getByLabelText('Management Health');

describe('a failed health read is reported, not rounded down to zero', () => {
  beforeEach(() => {
    mocks.health = HEALTHY;
    mocks.healthThrows = false;
    mocks.healthCalls = 0;
    mocks.releaseHealth = null;
  });

  /**
   * The defect itself. `?? 0` made this pass silently, which is why nothing
   * caught it: the rail rendered, the numbers were plausible, and every one of
   * them was invented by the nullish coalescing operator.
   */
  it('does not claim zero integrity alerts when it could not ask', async () => {
    mocks.healthThrows = true;
    await renderBoard();
    // No \b before the digit: the tiles are adjacent spans, so the rail's
    // textContent runs them together ("...0 Rejected0 Integrity Alerts...")
    // and there is no word boundary between "Rejected" and "0". The first
    // version of this assertion had one, and passed against the defect.
    expect(healthRail().textContent).not.toMatch(/0 Integrity Alerts/i);
    expect(healthRail().textContent).not.toMatch(/0 Realtime Events/i);
  });

  /** And says so, rather than rendering an empty rail that reads as "fine". */
  it('says the health read is unavailable', async () => {
    mocks.healthThrows = true;
    await renderBoard();
    expect(healthRail().textContent).toMatch(/unavailable/i);
  });

  /**
   * The board is the product; health is telemetry beside it. A refused health
   * read must never cost the operator the games.
   */
  it('still draws the board when health is refused', async () => {
    mocks.healthThrows = true;
    await renderBoard();
    expect(screen.getByText('Friday Deep Stack')).toBeInTheDocument();
  });

  /** A real zero is still a zero. The fix must not hide good news either. */
  it('reports a genuine zero as zero', async () => {
    await renderBoard();
    expect(healthRail().textContent).toMatch(/0 Integrity Alerts/i);
  });

  /**
   * `eventsLastHour` was fetched on every single load and rendered nowhere,
   * while the one tile that mentions events showed `eventRows` - the 30-day
   * retained total. An operator watching for a stalled feed was reading a
   * number that barely moves. The rate is the signal; the total is context.
   */
  it('shows the live event rate, not only the retained total', async () => {
    await renderBoard();
    expect(healthRail().textContent).toContain('935');
    expect(healthRail().textContent).toContain('259681');
  });

  /**
   * The regression the FIRST version of this fix shipped, caught the same day.
   *
   * `health` is null in two completely different situations: the read has not
   * come back yet, and the read failed. The original fix keyed the alarm off
   * `health === null`, so every ordinary page open displayed "Management
   * Health Unavailable" for the length of the first load before flipping to
   * numbers. Trading a false all-clear for a false alarm is not a fix; it just
   * moves which state lies.
   *
   * Three states, three renderings. This pins the middle one, which is the one
   * with no natural home and therefore the one that keeps getting collapsed
   * into a neighbour.
   */
  it('does not cry unavailable while the read is still in flight', async () => {
    mocks.releaseHealth = () => {};
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
    await waitFor(() => expect(screen.queryByLabelText('Management Health')).toBeInTheDocument());
    // Health has been asked and has not answered. Neither a number nor an alarm.
    expect(healthRail().textContent).not.toMatch(/unavailable/i);
    expect(healthRail().textContent).not.toMatch(/0 Integrity Alerts/i);
  });
});
