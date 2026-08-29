import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClubCapabilityGuard from '../../src/components/auth/ClubCapabilityGuard';
import ClubMemberGuard from '../../src/components/auth/ClubMemberGuard';
import type { ClubWorkspaceValue } from '../../src/contexts/ClubWorkspaceContext';

let workspace: ClubWorkspaceValue;

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

  it('shows a recoverable access error instead of redirecting to an invite', () => {
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
    expect(screen.getByText(/membership has not been changed/i)).toBeInTheDocument();
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
