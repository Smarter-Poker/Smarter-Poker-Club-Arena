/**
 * THE BAR DOES NO WORK ON A ROUTE IT CANNOT APPEAR ON
 *
 * `onTickerRoute` gated the managed-settings read and the render. It never
 * gated the FEED - four to five Supabase queries every thirty seconds - so a
 * player sitting on the cashier, the leaderboard, their profile or the club
 * list had a browser fetching tournaments, registrations, overlay candidates
 * and table openings twice a minute for a strip that cannot render on any of
 * those routes.
 *
 * It predates this programme and it survived the load pass, because that pass
 * gated each query on its SOURCE and never asked whether the component should
 * be running at all. A hook cannot be called conditionally, so the fix is a
 * gate component that does not mount the host - and this file is what holds it
 * shut.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  pathname: '/hub',
  showTicker: true as boolean | undefined,
  from: vi.fn(),
  rpc: vi.fn(),
  session: vi.fn(),
}));

const builder: Record<string, unknown> = {};
for (const method of ['select', 'eq', 'in', 'is', 'gt', 'gte', 'lte', 'order', 'limit']) {
  builder[method] = () => builder;
}
(builder as { maybeSingle: () => Promise<unknown> }).maybeSingle = async () => ({
  data: null,
  error: null,
});
(builder as { then: (r: (v: unknown) => void) => void }).then = (resolve) =>
  resolve({ data: [], error: null });

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      mocks.from(table);
      return builder;
    },
    rpc: (name: string, args: unknown) => {
      mocks.rpc(name, args);
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  },
}));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: mocks.session }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: mocks.pathname }),
}));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
  reportWarning: vi.fn(),
}));
vi.mock('../../src/core/MasterBus', () => ({
  busToast: vi.fn(),
  masterBus: { emit: vi.fn() },
}));
vi.mock('../../src/hooks/useTableSettings', () => ({
  useTableSettings: () => ({ settings: { showTicker: mocks.showTicker } }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
}));
vi.mock('../../src/hooks/useMaintenanceBreak', () => ({
  useMaintenanceBreak: () => ({ maintenanceBreak: { active: false, breakEndsAtMs: null } }),
}));

import { TournamentStartingTicker } from '../../src/components/tournament/TournamentStartingTicker';

/** Every route in Club Arena the bar is not allowed on. */
const QUIET_ROUTES = [
  '/hub',
  '/clubs',
  '/cashier',
  '/leaderboard',
  '/profile',
  '/marketplace',
  '/tournaments',
  '/clubs/club-a/members',
];

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
  mocks.session.mockReturnValue({ userId: 'viewer-a' });
  mocks.showTicker = true;
});
afterEach(cleanup);

describe('a route that cannot show the bar pays nothing for it', () => {
  for (const pathname of QUIET_ROUTES) {
    it(`touches no table and no function on ${pathname}`, async () => {
      mocks.pathname = pathname;
      render(<TournamentStartingTicker />);
      await new Promise((r) => setTimeout(r, 0));
      expect(mocks.from, `${pathname} queried a table`).not.toHaveBeenCalled();
      expect(mocks.rpc, `${pathname} called a function`).not.toHaveBeenCalled();
    });
  }

  it('renders nothing there either', () => {
    mocks.pathname = '/cashier';
    const { container } = render(<TournamentStartingTicker />);
    expect(container.firstChild).toBeNull();
  });
});

describe('a player who switched it off pays nothing for it', () => {
  it('does no work on a ticker route when the toggle is off', async () => {
    /* The toggle used to hide the bar and leave the poll running. */
    mocks.pathname = '/table/t-1';
    mocks.showTicker = false;
    render(<TournamentStartingTicker />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('and on a route that CAN show it, the work happens', () => {
  it('reads on a live table', async () => {
    mocks.pathname = '/table/11111111-2222-4333-8444-555555555555';
    render(<TournamentStartingTicker />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.from.mock.calls.length + mocks.rpc.mock.calls.length).toBeGreaterThan(0);
  });

  it('reads in a club lobby', async () => {
    mocks.pathname = '/clubs/club-a';
    render(<TournamentStartingTicker />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.from.mock.calls.length + mocks.rpc.mock.calls.length).toBeGreaterThan(0);
  });
});
