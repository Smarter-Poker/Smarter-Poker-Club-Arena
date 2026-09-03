import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const membershipRead = vi.hoisted(() => vi.fn());
const profileRead = vi.hoisted(() => vi.fn());
const abortRead = vi.hoisted(() => vi.fn());
const abortState = vi.hoisted(() => ({ signal: null as AbortSignal | null }));

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
        abortSignal: (signal: AbortSignal) => {
          abortState.signal = signal;
          abortRead(signal);
          return chain;
        },
        maybeSingle: table === 'club_members' ? membershipRead : profileRead,
      });
      return chain;
    },
  },
}));

import { ClubWorkspaceProvider, useClubWorkspace } from '../../src/contexts/ClubWorkspaceContext';
import { writeClubWorkspaceCache } from '../../src/lib/clubWorkspaceCache';

function WorkspaceProbe() {
  const workspace = useClubWorkspace();
  return (
    <div>
      <span>{workspace.status}</span>
      {workspace.isStale && <span>stale</span>}
      {workspace.error && <span>{workspace.error}</span>}
    </div>
  );
}

describe('ClubWorkspaceProvider transient reads', () => {
  beforeEach(() => {
    membershipRead.mockReset();
    profileRead.mockReset();
    abortRead.mockReset();
    abortState.signal = null;
    localStorage.clear();
    membershipRead
      .mockResolvedValueOnce({ data: null, error: { code: '503', message: 'fetch failed' } })
      .mockResolvedValueOnce({ data: { role: 'owner', status: 'active' }, error: null });
    profileRead.mockResolvedValue({ data: { role: 'player' }, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('aborts a hung authorization read and retries it to a real verdict', async () => {
    vi.useFakeTimers();
    membershipRead.mockReset();
    membershipRead
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            const signal = abortState.signal;
            if (!signal) throw new Error('The read started without an abort signal.');
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('The request was aborted.', 'AbortError')),
              { once: true }
            );
          })
      )
      .mockResolvedValueOnce({ data: { role: 'owner', status: 'active' }, error: null });

    render(
      <MemoryRouter initialEntries={['/clubs/a41434bb-8d0c-400a-8f0d-e8b3d65afed4/cashier']}>
        <ClubWorkspaceProvider>
          <WorkspaceProbe />
        </ClubWorkspaceProvider>
      </MemoryRouter>
    );

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(11_100);
    });

    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(membershipRead).toHaveBeenCalledTimes(2);
    expect(abortRead).toHaveBeenCalledTimes(3);
    for (const [signal] of abortRead.mock.calls) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('keeps a recently verified member in the route when live reads are temporarily down', async () => {
    vi.useFakeTimers();
    membershipRead.mockReset();
    membershipRead.mockRejectedValue(new Error('database connection unavailable'));
    writeClubWorkspaceCache({
      userId: 'user-1',
      routeClubId: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
      clubUUID: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
      clubRole: 'owner',
      membershipStatus: 'active',
      isPlatformStaff: false,
      verifiedAt: Date.now(),
    });

    render(
      <MemoryRouter initialEntries={['/clubs/a41434bb-8d0c-400a-8f0d-e8b3d65afed4/data']}>
        <ClubWorkspaceProvider>
          <WorkspaceProbe />
        </ClubWorkspaceProvider>
      </MemoryRouter>
    );

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.queryByText(/access could not be verified/i)).not.toBeInTheDocument();
    expect(membershipRead).toHaveBeenCalledTimes(3);
  });
});
