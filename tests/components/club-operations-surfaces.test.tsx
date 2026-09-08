/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RAIL AND THE TWO SUB-WORKSPACES CARRY THE SAME READING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03, phase 1 verification pass)
 *
 * The operations page got a render test the day the reading shipped. The two
 * surfaces that carry the same numbers - the rail that follows an operator into
 * every tool, and the /finance and /control sub-workspaces - did not, so
 * "the rail badges every tool" was a claim with nothing holding it up. Three of
 * the defects this file pins were found by writing it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClubWorkspaceValue } from '../../src/contexts/ClubWorkspaceContext';
import type { ClubNavigationAccess } from '../../src/hooks/useClubNavigationAccess';
import { resetClubOperationsOverviewCache } from '../../src/hooks/useClubOperationsOverview';
import ClubOperationsRail from '../../src/components/navigation/ClubOperationsRail';
import {
  ClubControlWorkspacePage,
  ClubFinanceWorkspacePage,
} from '../../src/pages/workspaces/ArenaWorkspacePages';

const CLUB_UUID = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const SLUG = 'deep-stack-society-11192';

const rpcMock = vi.fn();
let workspace: ClubWorkspaceValue;
let access: ClubNavigationAccess;

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: () => () => undefined,
    subscribeDebounced: () => () => undefined,
    emit: vi.fn(),
  },
}));
vi.mock('../../src/contexts/ClubWorkspaceContext', async () => {
  const actual = await vi.importActual('../../src/contexts/ClubWorkspaceContext');
  return { ...actual, useClubWorkspace: () => workspace };
});
vi.mock('../../src/hooks/useClubNavigationAccess', async () => {
  const actual = await vi.importActual('../../src/hooks/useClubNavigationAccess');
  return { ...actual, useClubNavigationAccess: () => access };
});

function payload() {
  return {
    generated_at: new Date().toISOString(),
    club: { id: CLUB_UUID, name: 'Deep Stack Society', slug: SLUG },
    viewer: {
      role: 'owner',
      is_platform_staff: false,
      can_view_finance: true,
      can_control_club: true,
    },
    kpis: {
      members: 417,
      members_pending: 3,
      members_new_7d: 12,
      online_now: 183,
      seated_now: 183,
      live_tables: 226,
      running_tables: 113,
      waiting_tables: 113,
      tournaments_registering: 58,
      tournaments_running: 2,
      hands_today: 122786,
      rake_today: '126140.93',
      club_bank: '2096087.81',
      member_chips: '4418693.40',
    },
    counts: {
      members: 417,
      members_pending: 3,
      reports_open: 1,
      disputes_open: 0,
      disputes_aged: 0,
      blacklist_active: 6,
      blacklist_expired: 0,
      chip_requests_pending: 4,
      cashouts_pending: 3,
      credit_requests_pending: 2,
      invoices_open: 5,
      invoices_overdue: 5,
      tickets_outstanding: 9,
      anti_cheat_flags_open: 0,
    },
    alerts: [
      {
        id: 'invoices-overdue',
        severity: 'critical',
        tool: 'settlement',
        title: 'Invoices Past Due',
        count: 5,
      },
      {
        id: 'chip-requests',
        severity: 'warning',
        tool: 'cashier',
        title: 'Chip Requests Waiting',
        count: 4,
      },
      {
        id: 'join-requests',
        severity: 'warning',
        tool: 'players',
        title: 'Membership Requests Waiting',
        count: 3,
      },
    ],
    settlement_locked: false,
  };
}

function makeWorkspace(overrides: Partial<ClubWorkspaceValue> = {}): ClubWorkspaceValue {
  return {
    routeClubId: SLUG,
    clubUUID: CLUB_UUID,
    clubRole: 'owner',
    membershipStatus: 'active',
    isMember: true,
    isPlatformStaff: false,
    status: 'ready',
    loading: false,
    error: null,
    isOffline: false,
    isStale: false,
    lastSyncedAt: Date.now(),
    reload: vi.fn(),
    isClubStaff: true,
    canViewFinance: true,
    canControlClub: true,
    ...overrides,
  };
}

function makeAccess(overrides: Partial<ClubNavigationAccess> = {}): ClubNavigationAccess {
  return {
    isClubStaff: true,
    canViewFinance: true,
    canControlClub: true,
    clubRole: 'owner',
    isPlatformStaff: false,
    loading: false,
    error: null,
    reload: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  resetClubOperationsOverviewCache();
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: payload(), error: null });
  workspace = makeWorkspace();
  access = makeAccess();
});

function mountRail(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<ClubOperationsRail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('the rail carries the queue into every tool', () => {
  it('badges the tools that have work waiting', async () => {
    mountRail(`/clubs/${SLUG}/blacklist`);
    await waitFor(() => expect(screen.getByLabelText('3 Waiting')).toBeTruthy());
    // Players: 3 membership requests. Reports: 1.
    expect(screen.getByLabelText('1 Waiting')).toBeTruthy();
    // The cashier desk is one tool for three queues: 4 chip requests, 3 cash
    // outs and 2 credit requests roll into the Finance Overview rail item
    // together with the 5 open invoices.
    expect(screen.getByLabelText('14 Waiting')).toBeTruthy();
    // The identity plate carries the whole workspace: 3 + 1 + 9 + 5.
    expect(screen.getByLabelText('18 Waiting')).toBeTruthy();
  });

  it('marks the group parent current when the tool itself is not in the rail', async () => {
    mountRail(`/clubs/${SLUG}/blacklist`);
    await waitFor(() => expect(screen.getByLabelText('3 Waiting')).toBeTruthy());
    // Blacklist is a People tool, so the workspace overview is its parent.
    const current = document.querySelector('[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe(`/clubs/${SLUG}/operations`);
  });

  it('renders nothing at all for a viewer who is not club staff', async () => {
    access = makeAccess({ isClubStaff: false, canViewFinance: false, canControlClub: false });
    const { container } = mountRail(`/clubs/${SLUG}/members`);
    await waitFor(() => expect(container.querySelector('nav')).toBeNull());
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('stays out of the way on a route outside the workspace', async () => {
    const { container } = mountRail(`/clubs/${SLUG}/lobby`);
    await waitFor(() => expect(container.querySelector('nav')).toBeNull());
  });
});

function mountWorkspace(kind: 'finance' | 'control') {
  const Page = kind === 'finance' ? ClubFinanceWorkspacePage : ClubControlWorkspacePage;
  return render(
    <MemoryRouter initialEntries={[`/clubs/${SLUG}/${kind}`]}>
      <Routes>
        <Route path={`/clubs/:clubId/${kind}`} element={<Page />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('the finance sub-workspace reads its own group', () => {
  it('paints the money and the outstanding tickets', async () => {
    mountWorkspace('finance');
    await waitFor(() => expect(screen.getByText('Club Bank')).toBeTruthy());
    expect(screen.getByText('2,096,087.81')).toBeTruthy();
    expect(screen.getByText('4,418,693.40')).toBeTruthy();
    expect(screen.getByText('126,140.93')).toBeTruthy();
    expect(screen.getByText('Tickets Outstanding')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
  });

  it('shows only the alerts its own tools own', async () => {
    mountWorkspace('finance');
    await waitFor(() => expect(screen.getByText('Invoices Past Due')).toBeTruthy());
    expect(screen.getByText('Chip Requests Waiting')).toBeTruthy();
    // A membership queue belongs to People, not to Finance.
    expect(screen.queryByText('Membership Requests Waiting')).toBeNull();
  });

  it('badges the cashier with every queue that lands on that desk', async () => {
    mountWorkspace('finance');
    await waitFor(() => expect(screen.getByText('Cashier')).toBeTruthy());
    const cashier = screen.getByText('Cashier').closest('a');
    expect(await within(cashier as HTMLElement).findByText('9 Waiting')).toBeTruthy();
  });

  it('stops promising live systems when nothing could be read', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'boom' } });
    mountWorkspace('finance');
    await waitFor(() => expect(screen.getByText('Cashier')).toBeTruthy());
    expect(screen.getByText(/Live Systems Remain Authoritative/i)).toBeTruthy();
    expect(screen.queryByText(/Read Live From This Club/i)).toBeNull();
  });
});

describe('the control sub-workspace reads its own group', () => {
  it('paints the house readings, including the exclusion ledger', async () => {
    mountWorkspace('control');
    await waitFor(() => expect(screen.getByText('Excluded Players')).toBeTruthy());
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('Membership Requests')).toBeTruthy();
    expect(screen.getByText('417')).toBeTruthy();
  });

  it('lists the tools that had no door before phase 1', async () => {
    mountWorkspace('control');
    await waitFor(() => expect(screen.getByText('Promo Vault')).toBeTruthy());
    expect(screen.getByText('Table Management')).toBeTruthy();
    expect(screen.getByText('Player Offers')).toBeTruthy();
    // The overview tile never links to itself.
    expect(screen.queryByText('Control Overview')).toBeNull();
  });
});
