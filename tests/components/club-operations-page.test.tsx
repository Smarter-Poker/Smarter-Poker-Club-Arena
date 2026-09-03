/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE OPERATIONS WORKSPACE IS A READING, AND IT NEVER TAKES THE DOORS AWAY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03)
 *
 * /operations, /finance and /control had no test that MOUNTED them. Every
 * assertion about them anywhere in this suite was a readFileSync string match,
 * which is why three of the page's states could be dead for weeks without
 * anything noticing, and why the page could promise "Live Permission Map" over
 * three panels that made no query at all.
 *
 * Two properties matter more than the numbers themselves:
 *
 *   1. A number on this page came from the database and is formatted for a
 *      human. 122786 is not a readable count of hands.
 *   2. A FAILED reading costs the operator the badges and nothing else. The
 *      twenty-one tools are how they do their job; a degraded overview must
 *      never be allowed to hide them.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClubWorkspaceValue } from '../../src/contexts/ClubWorkspaceContext';
import type { ClubNavigationAccess } from '../../src/hooks/useClubNavigationAccess';
import { resetClubOperationsOverviewCache } from '../../src/hooks/useClubOperationsOverview';
import ClubOperationsPage, { ago, freshnessLabel } from '../../src/pages/club/ClubOperationsPage';

const CLUB_UUID = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';

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

/** PostgREST hands numerics back as strings. The fixture does too, on purpose. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    generated_at: new Date().toISOString(),
    club: { id: CLUB_UUID, name: 'Deep Stack Society', slug: 'deep-stack-society-11192' },
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
      reports_open: 0,
      disputes_open: 0,
      disputes_aged: 0,
      blacklist_active: 0,
      blacklist_expired: 0,
      chip_requests_pending: 4,
      cashouts_pending: 3,
      credit_requests_pending: 2,
      invoices_open: 0,
      invoices_overdue: 0,
      tickets_outstanding: 0,
      anti_cheat_flags_open: 0,
    },
    alerts: [
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
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<ClubWorkspaceValue> = {}): ClubWorkspaceValue {
  return {
    routeClubId: 'deep-stack-society-11192',
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

function mount() {
  return render(
    <MemoryRouter initialEntries={['/clubs/deep-stack-society-11192/operations']}>
      <Routes>
        <Route path="/clubs/:clubId/operations" element={<ClubOperationsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetClubOperationsOverviewCache();
  rpcMock.mockReset();
  workspace = makeWorkspace();
  access = makeAccess();
});

describe('the operations workspace reads the club', () => {
  it('asks for the club by uuid, never by the slug in the url', async () => {
    rpcMock.mockResolvedValue({ data: payload(), error: null });
    mount();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock).toHaveBeenCalledWith('ca_club_operations_overview', {
      p_club_id: CLUB_UUID,
    });
  });

  it('never sends a slug to a uuid argument while the club is unresolved', async () => {
    workspace = makeWorkspace({ clubUUID: null, status: 'loading', loading: true });
    mount();
    await waitFor(() => expect(screen.getByText('Club Operations')).toBeTruthy());
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('paints every live reading, formatted for a person', async () => {
    rpcMock.mockResolvedValue({ data: payload(), error: null });
    mount();
    await waitFor(() => expect(screen.getByText('Hands Today')).toBeTruthy());
    expect(screen.getByText('122,786')).toBeTruthy();
    expect(screen.getByText('417')).toBeTruthy();
    expect(screen.getByText('226')).toBeTruthy();
    expect(screen.getByText('113 Running, 113 Waiting')).toBeTruthy();
    // Numeric-as-string from PostgREST still renders as money, not as NaN.
    expect(screen.getByText('126,140.93')).toBeTruthy();
    expect(screen.getByText('2,096,087.81')).toBeTruthy();
    expect(screen.getByText('4,418,693.40 In Member Wallets')).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('withholds the money tiles from a staff member without finance access', async () => {
    access = makeAccess({ canViewFinance: false, canControlClub: false, clubRole: 'agent' });
    const staffOnly = payload();
    delete (staffOnly.kpis as Record<string, unknown>).rake_today;
    delete (staffOnly.kpis as Record<string, unknown>).club_bank;
    delete (staffOnly.kpis as Record<string, unknown>).member_chips;
    rpcMock.mockResolvedValue({ data: staffOnly, error: null });
    mount();
    await waitFor(() => expect(screen.getByText('Hands Today')).toBeTruthy());
    expect(screen.queryByText('Club Bank')).toBeNull();
    expect(screen.queryByText('Fees Today')).toBeNull();
  });

  it('lists what is waiting and links each line to the tool that owns it', async () => {
    rpcMock.mockResolvedValue({ data: payload(), error: null });
    mount();
    await waitFor(() => expect(screen.getByText('Chip Requests Waiting')).toBeTruthy());
    const cashierAlert = screen.getByText('Chip Requests Waiting').closest('a');
    expect(cashierAlert?.getAttribute('href')).toBe('/clubs/deep-stack-society-11192/cashier');
    const playersAlert = screen.getByText('Membership Requests Waiting').closest('a');
    expect(playersAlert?.getAttribute('href')).toBe('/clubs/deep-stack-society-11192/members');
  });

  it('badges the tool that has work waiting and leaves the others alone', async () => {
    rpcMock.mockResolvedValue({ data: payload(), error: null });
    mount();
    await waitFor(() => expect(screen.getByText('Chip Requests Waiting')).toBeTruthy());
    expect(screen.getByLabelText('3 Waiting')).toBeTruthy();
    // The cashier is one desk for three queues: 4 chip requests, 3 cash outs
    // and 2 credit requests. A badge of 4 would send an operator to a tile
    // reading 4 with 9 things behind it.
    expect(screen.getByLabelText('9 Waiting')).toBeTruthy();
    // Nothing is waiting in Reports, so the tile carries no number.
    const reports = screen.getByText('Reports').closest('a');
    expect(reports?.textContent).not.toMatch(/\d/);
  });

  it('reserves the reading strip while the first read is in flight', async () => {
    rpcMock.mockReturnValue(new Promise(() => undefined));
    mount();
    await waitFor(() => expect(screen.getByLabelText('Reading The Club')).toBeTruthy());
    expect(screen.getByText('Reading The Club')).toBeTruthy();
    expect(screen.getByLabelText('Reading The Club').getAttribute('aria-busy')).toBe('true');
  });
});

describe('a failed reading never takes the tools away', () => {
  it('renders every permitted tool and says the reading is unavailable', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'boom' } });
    mount();
    await waitFor(() => expect(screen.getByText('Live Readings Unavailable')).toBeTruthy());
    for (const label of [
      'Dashboard',
      'Players',
      'Reports',
      'Anti-Cheat',
      'Cashier',
      'Settlement',
      'Promo Vault',
      'Table Management',
      'Bomb Pot Report',
      'Settings',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('keeps the age of the numbers that are still on screen', async () => {
    rpcMock.mockResolvedValueOnce({ data: payload(), error: null });
    mount();
    await waitFor(() => expect(screen.getByText('122,786')).toBeTruthy());
    // A failed refresh used to drop the timestamp, so an operator was left
    // reading figures of unknown age with no way to tell.
    rpcMock.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'boom' } });
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() =>
      expect(screen.getByText(/Live Readings Unavailable, Last Read/i)).toBeTruthy()
    );
    // The last good numbers are still there, and still labelled.
    expect(screen.getByText('122,786')).toBeTruthy();
  });

  it('renders the tools even when the club refuses the reading outright', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'not authorized for this club' },
    });
    mount();
    await waitFor(() => expect(screen.getByText('Players')).toBeTruthy());
    // A refusal is not an error the operator can fix by retrying, so the page
    // says so plainly and does not offer a failure they might chase.
    expect(screen.queryByText('Live Readings Unavailable')).toBeNull();
    expect(screen.getByText('Live Readings Restricted For This Role')).toBeTruthy();
  });
});

describe('the workspace is still permission aware', () => {
  it('refuses a non-staff viewer without asking the database anything', async () => {
    access = makeAccess({
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
      clubRole: 'player',
    });
    mount();
    await waitFor(() => expect(screen.getByText(/Club Operations Is Restricted/i)).toBeTruthy());
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('shows an agent only the tools an agent may open', async () => {
    access = makeAccess({ canViewFinance: false, canControlClub: false, clubRole: 'agent' });
    rpcMock.mockResolvedValue({ data: payload(), error: null });
    mount();
    await waitFor(() => expect(screen.getByText('Players')).toBeTruthy());
    expect(screen.getByText('Anti-Cheat')).toBeTruthy();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Club Data')).toBeNull();
    expect(screen.queryByText('Blacklist')).toBeNull();
  });
});

describe('the freshness line', () => {
  const then = 1_000_000_000_000;

  it('reads as Title Case at every scale', () => {
    expect(ago(then, then + 3_000)).toBe('Just Now');
    expect(ago(then, then + 42_000)).toBe('42s Ago');
    expect(ago(then, then + 5 * 60_000)).toBe('5m Ago');
    expect(ago(then, then + 3 * 3_600_000)).toBe('3h Ago');
    expect(ago(then, then + 2 * 86_400_000)).toBe('2d Ago');
  });

  it('never claims a reading it does not have, and never hides a stale age', () => {
    expect(freshnessLabel({ error: false, denied: false, loading: true, refreshedAt: null })).toBe(
      'Reading The Club'
    );
    expect(freshnessLabel({ error: false, denied: false, loading: false, refreshedAt: null })).toBe(
      'Awaiting First Reading'
    );
    expect(freshnessLabel({ error: false, denied: true, loading: false, refreshedAt: null })).toBe(
      'Live Readings Restricted For This Role'
    );
    expect(
      freshnessLabel({
        error: false,
        denied: false,
        loading: false,
        refreshedAt: then,
        now: then + 90_000,
      })
    ).toBe('Updated 1m Ago');
    expect(
      freshnessLabel({
        error: true,
        denied: false,
        loading: false,
        refreshedAt: then,
        now: then + 90_000,
      })
    ).toBe('Live Readings Unavailable, Last Read 1m Ago');
    expect(freshnessLabel({ error: true, denied: false, loading: false, refreshedAt: null })).toBe(
      'Live Readings Unavailable'
    );
  });
});
