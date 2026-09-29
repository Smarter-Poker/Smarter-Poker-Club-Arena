/**
 * The member door (src/pages/ClubMemberDoor.tsx). Phase 10, line 6: a typed
 * /clubs/diamond-arena/members/<id> opens the arena's own Players page, never
 * the chip club's member-management screen, and replaces the typed address so
 * Back does not return to it. A chip club still gets its management screen.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ automatic: false }));

vi.mock('../../src/components/arena/arenaAccess', () => ({
  useAutomaticArenaMembership: () => state.automatic,
}));
vi.mock('../../src/pages/MemberManagementPage', () => ({
  default: () => <div>Chip Member Management</div>,
}));

import ClubMemberDoor from '../../src/pages/ClubMemberDoor';

const MEMBER = '5b1c0d2e-0000-4000-8000-000000000001';

function openAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/clubs/:clubId/members', element: <div>Players Page</div> },
      { path: '/clubs/:clubId/members/:userId', element: <ClubMemberDoor /> },
    ],
    { initialEntries: [path] }
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  cleanup();
  state.automatic = false;
});

describe('ClubMemberDoor', () => {
  it('sends a member URL typed inside the Diamond Arena to its Players page', async () => {
    state.automatic = true;
    const router = openAt(`/clubs/diamond-arena/members/${MEMBER}`);
    expect(await screen.findByText('Players Page')).toBeInTheDocument();
    expect(screen.queryByText('Chip Member Management')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/clubs/diamond-arena/members');
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('leaves a chip club on its member-management screen', () => {
    const router = openAt(`/clubs/some-chip-club/members/${MEMBER}`);
    expect(screen.getByText('Chip Member Management')).toBeInTheDocument();
    expect(screen.queryByText('Players Page')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/clubs/some-chip-club/members/${MEMBER}`);
  });
});
