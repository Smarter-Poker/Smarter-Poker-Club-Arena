import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A VERIFIED CLUB PAGE STAYS MOUNTED WHILE ITS ACCESS IS RE-CHECKED (2026-10-19)
 *
 * Post-Deploy E2E failed on production Shark Club Players three times in one
 * morning (runs 39197316124, 39207700170, 39212954477) with an aborted
 * `ca_club_members_page` read. The request timelines all had the same shape:
 * the page read its roster, then read the WHOLE roster again about a second
 * later, and again a second after that, with nobody touching it. Each re-read
 * carried a fresh summary request too, which only a brand-new page instance
 * makes - the page was being unmounted and mounted again, and whichever read
 * was in flight when the viewer clicked a player was the one aborted.
 *
 * The cause was here. Every re-verification of club access - a CLUB_UPDATED
 * or MEMBER_ROLE_CHANGED event on the bus, the auth hook finishing its own
 * hydration, the online event - began by setting the workspace back to
 * `loading`. The member guard renders a skeleton for `loading`, so every
 * guarded club page (the roster, the cashier, every operations surface) was
 * torn down mid-use and rebuilt, losing its scroll, drafts and in-flight reads,
 * for a check that almost always came back with the same answer.
 *
 * A re-check now keeps the verified answer on screen until the new answer
 * arrives. A revocation still lands: the new answer is `denied`, and the guard
 * acts on it. Only a cold load - no verified answer yet for this club and
 * account - shows `loading`.
 */

const membershipRead = vi.hoisted(() => vi.fn());
const profileRead = vi.hoisted(() => vi.fn());
const bus = vi.hoisted(() => new Map<string, () => void>());
const auth = vi.hoisted(() => ({ isHydrating: false }));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'user-1' }, isHydrating: auth.isHydrating }),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: (event: string, callback: () => void) => {
      bus.set(event, callback);
      return () => bus.delete(event);
    },
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
        abortSignal: self,
        maybeSingle: table === 'club_members' ? membershipRead : profileRead,
      });
      return chain;
    },
  },
}));

import { ClubWorkspaceProvider, useClubWorkspace } from '../../src/contexts/ClubWorkspaceContext';

const CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
let mounts = 0;
let statuses: string[] = [];

function GuardedPage() {
  useEffect(() => {
    mounts++;
  }, []);
  return <span>page</span>;
}

/** The same decision ClubMemberGuard makes: no verdict yet means a skeleton. */
function Guard() {
  const workspace = useClubWorkspace();
  statuses.push(workspace.status);
  if (workspace.status === 'loading' || workspace.status === 'idle') return <span>skeleton</span>;
  if (!workspace.isMember) return <span>{workspace.status}</span>;
  return <GuardedPage />;
}

function app() {
  return (
    <MemoryRouter initialEntries={[`/clubs/${CLUB}/members`]}>
      <ClubWorkspaceProvider>
        <Guard />
      </ClubWorkspaceProvider>
    </MemoryRouter>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

describe('a verified club page stays mounted while its access is re-checked', () => {
  beforeEach(() => {
    mounts = 0;
    statuses = [];
    bus.clear();
    auth.isHydrating = false;
    localStorage.clear();
    membershipRead.mockReset();
    profileRead.mockReset();
    membershipRead.mockResolvedValue({ data: { role: 'owner', status: 'active' }, error: null });
    profileRead.mockResolvedValue({ data: { role: 'player' }, error: null });
  });

  it('shows loading on a cold load, then mounts the page once', async () => {
    render(app());
    expect(screen.getByText('skeleton')).toBeTruthy();
    expect(await screen.findByText('page')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  it('keeps the page mounted through a bus re-check that confirms access', async () => {
    render(app());
    expect(await screen.findByText('page')).toBeTruthy();
    let answer!: (value: unknown) => void;
    membershipRead.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    statuses = [];

    act(() => bus.get('CLUB_UPDATED')!());
    await settle();
    // The re-check is in flight. The verified page is still on screen.
    expect(membershipRead).toHaveBeenCalledTimes(2);
    expect(screen.getByText('page')).toBeTruthy();

    answer({ data: { role: 'owner', status: 'active' }, error: null });
    await settle();
    expect(screen.getByText('page')).toBeTruthy();
    expect(statuses).not.toContain('loading');
    expect(mounts).toBe(1);
  });

  it('still acts on a revocation the re-check returns', async () => {
    render(app());
    expect(await screen.findByText('page')).toBeTruthy();
    membershipRead.mockResolvedValueOnce({
      data: { role: 'member', status: 'removed' },
      error: null,
    });

    act(() => bus.get('MEMBER_ROLE_CHANGED')!());
    await settle();
    expect(screen.getByText('denied')).toBeTruthy();
    expect(screen.queryByText('page')).toBeNull();
  });

  it('keeps the page mounted when the auth hook finishes hydrating after the verdict', async () => {
    auth.isHydrating = true;
    const view = render(app());
    expect(await screen.findByText('page')).toBeTruthy();
    statuses = [];

    auth.isHydrating = false;
    view.rerender(app());
    await settle();
    expect(screen.getByText('page')).toBeTruthy();
    expect(statuses).not.toContain('loading');
    expect(mounts).toBe(1);
  });
});
