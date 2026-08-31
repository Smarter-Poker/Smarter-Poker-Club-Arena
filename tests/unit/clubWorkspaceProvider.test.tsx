import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const membershipRead = vi.hoisted(() => vi.fn());
const profileRead = vi.hoisted(() => vi.fn());

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'user-1' }, isHydrating: false }),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: () => vi.fn(),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        maybeSingle: table === 'club_members' ? membershipRead : profileRead,
      });
      return chain;
    },
  },
}));

import { ClubWorkspaceProvider, useClubWorkspace } from '../../src/contexts/ClubWorkspaceContext';

function WorkspaceProbe() {
  const workspace = useClubWorkspace();
  return (
    <div>
      <span>{workspace.status}</span>
      {workspace.error && <span>{workspace.error}</span>}
    </div>
  );
}

describe('ClubWorkspaceProvider transient reads', () => {
  beforeEach(() => {
    membershipRead.mockReset();
    profileRead.mockReset();
    membershipRead
      .mockResolvedValueOnce({ data: null, error: { code: '503', message: 'fetch failed' } })
      .mockResolvedValueOnce({ data: { role: 'owner', status: 'active' }, error: null });
    profileRead.mockResolvedValue({ data: { role: 'player' }, error: null });
  });

  it('retries a transient membership read before rendering an access fault', async () => {
    render(
      <MemoryRouter initialEntries={['/clubs/a41434bb-8d0c-400a-8f0d-e8b3d65afed4/cashier']}>
        <ClubWorkspaceProvider>
          <WorkspaceProbe />
        </ClubWorkspaceProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText('ready', {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(membershipRead).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/access could not be verified/i)).not.toBeInTheDocument();
  });
});
