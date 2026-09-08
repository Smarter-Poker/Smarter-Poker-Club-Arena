import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClubCapabilityGuard from '../../src/components/auth/ClubCapabilityGuard';
import ClubMemberGuard from '../../src/components/auth/ClubMemberGuard';
import type { ClubWorkspaceValue } from '../../src/contexts/ClubWorkspaceContext';

let workspace: ClubWorkspaceValue;
const arenaMocks = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock('../../src/services/ArenaContextService', () => ({ getArenaContext: arenaMocks.access }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));
beforeEach(() => {
  arenaMocks.access.mockReset();
  arenaMocks.access.mockImplementation(async () => ({
    arena: { id: 'club-1', kind: 'chip_club', asset: 'chips' },
    member: workspace.status !== 'denied',
    automaticMembership: false,
    role: 'player',
  }));
});

vi.mock('../../src/contexts/ClubWorkspaceContext', async () => {
  const actual = await vi.importActual('../../src/contexts/ClubWorkspaceContext');
  return { ...actual, useClubWorkspace: () => workspace };
});

vi.mock('../../src/lib/analytics', () => ({ capture: vi.fn() }));

function makeWorkspace(overrides: Partial<ClubWorkspaceValue> = {}): ClubWorkspaceValue {
  return {
    routeClubId: 'club-1',
    clubUUID: '00000000-0000-4000-8000-000000000001',
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

describe('a capability that is not yet known is not a denial', () => {
  /* 2026-09-02. ClubWorkspaceContext hands out CLOSED_CAPABILITIES for every
     status that is not `ready`, `loading` included. ClubCapabilityGuard read
     that as a decision and told the OWNER of a club "This Tool Is Restricted",
     on every cold load of a finance or control route.

     Not theoretical: the E2E account is owner of SHARK CLUB, and the
     Playwright snapshot from run 33567090010 caught the permission gate
     rendered on /clubs/shark-club/data for it. The suite then sat on that gate
     for its full 60s poll and went red. Warm caches hid it from everyone else.

     The three cases below are the whole contract. */
  beforeEach(() => {
    workspace = makeWorkspace();
  });

  it('does not deny an owner while the workspace is still loading', () => {
    // Exactly the production shape: role not resolved yet, so every capability
    // reads closed.
    workspace = makeWorkspace({
      status: 'loading',
      loading: true,
      clubRole: null,
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
    });
    render(
      <MemoryRouter initialEntries={['/clubs/club-1/finance']}>
        <Routes>
          <Route
            path="/clubs/:clubId/finance"
            element={
              <ClubCapabilityGuard>
                <div>finance surface</div>
              </ClubCapabilityGuard>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.queryByText(/This Tool Is Restricted/i)).toBeNull();
  });

  it('and does not flash the surface either, because undecided is not allowed', () => {
    // Rendering children while undecided would show a finance page to someone
    // who may turn out not to be allowed to see it. Neither answer is correct
    // yet, so neither is rendered.
    workspace = makeWorkspace({
      status: 'loading',
      loading: true,
      clubRole: null,
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
    });
    render(
      <MemoryRouter initialEntries={['/clubs/club-1/finance']}>
        <Routes>
          <Route
            path="/clubs/:clubId/finance"
            element={
              <ClubCapabilityGuard>
                <div>finance surface</div>
              </ClubCapabilityGuard>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.queryByText('finance surface')).toBeNull();
  });

  it('still denies once the answer is actually known', () => {
    // The guard must not become permissive. A resolved workspace that says no
    // is a real denial and still renders the gate.
    workspace = makeWorkspace({
      status: 'ready',
      loading: false,
      clubRole: 'member',
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
    });
    render(
      <MemoryRouter initialEntries={['/clubs/club-1/finance']}>
        <Routes>
          <Route
            path="/clubs/:clubId/finance"
            element={
              <ClubCapabilityGuard>
                <div>finance surface</div>
              </ClubCapabilityGuard>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/This Tool Is Restricted/i)).toBeInTheDocument();
  });
});

describe('club route guards', () => {
  beforeEach(() => {
    workspace = makeWorkspace();
  });

  it.each([
    ['/clubs/club-1/operations', { isClubStaff: true }],
    ['/clubs/club-1/finance', { isClubStaff: true, canViewFinance: true }],
    ['/clubs/club-1/control', { isClubStaff: true, canViewFinance: true, canControlClub: true }],
  ])('renders an authorized %s surface', (path, capabilities) => {
    workspace = makeWorkspace(capabilities);
    render(
      <MemoryRouter initialEntries={[path]}>
        <ClubCapabilityGuard>
          <div>Protected Tool</div>
        </ClubCapabilityGuard>
      </MemoryRouter>
    );
    expect(screen.getByText('Protected Tool')).toBeInTheDocument();
  });

  it('fails closed when a finance capability is absent', () => {
    workspace = makeWorkspace({
      clubRole: 'agent',
      canViewFinance: false,
      canControlClub: false,
    });
    render(
      <MemoryRouter initialEntries={['/clubs/club-1/finance']}>
        <ClubCapabilityGuard>
          <div>Protected Tool</div>
        </ClubCapabilityGuard>
      </MemoryRouter>
    );
    expect(screen.queryByText('Protected Tool')).not.toBeInTheDocument();
    expect(screen.getByText('This Tool Is Restricted')).toBeInTheDocument();
  });

  it('shows a recoverable access error instead of redirecting to an invite', async () => {
    workspace = makeWorkspace({
      status: 'error',
      isMember: false,
      error: 'Club access could not be verified. Your membership has not been changed.',
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
    });
    render(
      <MemoryRouter initialEntries={['/clubs/club-1/finance']}>
        <Routes>
          <Route
            path="/clubs/:clubId/finance"
            element={
              <ClubMemberGuard>
                <div>Finance</div>
              </ClubMemberGuard>
            }
          />
          <Route path="/invite/:clubId" element={<div>Invite Route</div>} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText(/membership has not been changed/i)).toBeInTheDocument();
    expect(screen.queryByText('Invite Route')).not.toBeInTheDocument();
  });

  it('redirects a confirmed non-member to the existing invite route', async () => {
    workspace = makeWorkspace({
      status: 'denied',
      isMember: false,
      membershipStatus: null,
      isClubStaff: false,
      canViewFinance: false,
      canControlClub: false,
    });
    render(
      <MemoryRouter initialEntries={['/clubs/club-1']}>
        <Routes>
          <Route
            path="/clubs/:clubId"
            element={
              <ClubMemberGuard>
                <div>Club</div>
              </ClubMemberGuard>
            }
          />
          <Route path="/invite/:clubId" element={<div>Invite Route</div>} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Invite Route')).toBeInTheDocument());
  });
});

describe('Diamond entitlement precedes every private club guard', () => {
  it.each(['/clubs/diamond', '/clubs/diamond/finance', '/clubs/diamond/agents'])(
    'never redirects automatic Diamond members or mounts chip tools at %s',
    async (path) => {
      workspace = makeWorkspace({ status: 'denied', isMember: false, membershipStatus: null });
      arenaMocks.access.mockResolvedValue({
        arena: { id: 'diamond', kind: 'diamond_arena', asset: 'diamonds' },
        member: true,
        automaticMembership: true,
        role: 'player',
      });
      render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/clubs/:clubId/*"
              element={
                <ClubMemberGuard>
                  <div>Chip Tool</div>
                </ClubMemberGuard>
              }
            />
            <Route path="/invite/:clubId" element={<div>Invite Route</div>} />
          </Routes>
        </MemoryRouter>
      );
      expect(await screen.findByText('You Are Already A Member.')).toBeInTheDocument();
      expect(screen.queryByText('Invite Route')).toBeNull();
      expect(screen.queryByText('Chip Tool')).toBeNull();
      expect(arenaMocks.access).toHaveBeenCalledTimes(1);
    }
  );
});
