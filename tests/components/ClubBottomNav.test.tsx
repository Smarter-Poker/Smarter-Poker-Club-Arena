import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClubBottomNav from '../../src/components/club/ClubBottomNav';
import { clubIdFromPath } from '../../src/components/club/clubIdFromPath';
import { activeTabForPath } from '../../src/components/club/clubBottomNavTabs';
import { STORAGE_KEYS } from '../../src/lib/storage';

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'user-1' }, loading: false }),
}));

vi.mock('../../src/contexts/ClubWorkspaceContext', () => ({
  useClubWorkspace: () => ({
    routeClubId: '11111111-2222-3333-4444-555555555555',
    clubUUID: '11111111-2222-3333-4444-555555555555',
    clubRole: 'owner',
    isPlatformStaff: false,
    isClubStaff: true,
    canViewFinance: true,
    canControlClub: true,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

/**
 * The cold-cache path calls fetchQuickLinkClubs, which hits Supabase. Left
 * unmocked it makes a real request from a unit test and settles after the
 * assertions, which is where the "update not wrapped in act" warnings came
 * from. An empty membership list is the case these tests care about anyway.
 */
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => {
        const chain: any = {
          eq: () => chain,
          in: async () => ({ data: [], error: null }),
        };
        return chain;
      },
    }),
  },
}));

const CLUB = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const LABELS = ['Settings', 'Players', 'Cashier', 'Market', 'Data', 'Stats'];

function seedClubs(ids: string[] = [CLUB], last: string | null = CLUB) {
  localStorage.setItem(
    STORAGE_KEYS.CLUBS_CACHE,
    JSON.stringify(ids.map((id) => ({ id, name: id, is_union: false })))
  );
  if (last) localStorage.setItem(STORAGE_KEYS.LAST_CLUB, last);
}

async function renderAt(path: string, clubId?: string) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <ClubBottomNav clubId={clubId} />
    </MemoryRouter>
  );
  await act(async () => Promise.resolve());
  return view;
}

const links = () => screen.getAllByRole('link');
const labels = () => links().map((link) => link.getAttribute('aria-label'));
const hrefs = () => links().map((link) => link.getAttribute('href'));

describe('activeTabForPath', () => {
  it.each([
    [`/clubs/${CLUB}/settings`, 'profile'],
    [`/clubs/${CLUB}/members`, 'players'],
    [`/clubs/${CLUB}/cashier`, 'cashier'],
    ['/marketplace', 'marketplace'],
    [`/clubs/${CLUB}/dashboard`, 'data'],
    [`/clubs/${CLUB}/data`, 'data'],
    ['/stats', 'stats'],
  ])('%s marks %s current', (path, expected) => {
    expect(activeTabForPath(path)).toBe(expected);
  });
});

describe('clubIdFromPath', () => {
  it('extracts and decodes the current route club immediately', () => {
    expect(clubIdFromPath(`/clubs/${CLUB}/cashier`)).toBe(CLUB);
    expect(clubIdFromPath('/clubs/my%20club/members')).toBe('my club');
    expect(clubIdFromPath('/marketplace')).toBeNull();
  });
});

describe('ClubBottomNav approved footer contract', () => {
  beforeEach(() => localStorage.clear());

  it('always exposes exactly the six approved controls in approved order', async () => {
    seedClubs();
    await renderAt(`/clubs/${CLUB}/settings`, CLUB);

    expect(labels()).toEqual(LABELS);
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByRole('navigation', { name: 'Club Arena' })).toBeInTheDocument();
  });

  it('keeps the current control and marks it with aria-current', async () => {
    seedClubs();
    await renderAt('/marketplace');

    expect(screen.getByRole('link', { name: 'Market' })).toHaveAttribute('aria-current', 'page');
    expect(labels()).toEqual(LABELS);
  });

  /* UPDATED 2026-09-02 with the change it pins. This expected `/marketplace`
     and `/stats` bare, which was the footer's real behaviour and is now a bug
     by Dan's rule: "IF YOU ARE A PART OF MULTIPLE CLUBS (OR UNIONS) IT SHOULD
     ALWAYS BE OPEN TO THAT SPECIFIC CLUB." Those two cells have no
     club-scoped ROUTE, so they were left global while the four around them
     carried the club — the same footer both keeping and dropping the club
     depending on which cell you pressed. Both pages read `?club=`, so the
     club now rides in the query. See tests/the-menu-stays-in-the-club.law.test.ts. */
  it('carries the known club on every destination, by path or by query', async () => {
    await renderAt('/', CLUB);

    expect(hrefs()).toEqual([
      `/clubs/${CLUB}/settings`,
      `/clubs/${CLUB}/members`,
      `/clubs/${CLUB}/cashier`,
      `/marketplace?club=${CLUB}`,
      `/clubs/${CLUB}/data`,
      `/stats?club=${CLUB}`,
    ]);
  });

  it('resolves the last valid club from the lobby cache', async () => {
    seedClubs([OTHER], CLUB);
    await renderAt('/stats');

    expect(hrefs()).toContain(`/clubs/${OTHER}/settings`);
    expect(hrefs().some((href) => href?.includes(CLUB))).toBe(false);
  });

  it('uses the current route club before a stale cached club', async () => {
    seedClubs([OTHER], OTHER);
    await renderAt(`/clubs/${CLUB}/cashier`);

    expect(hrefs()).toContain(`/clubs/${CLUB}/settings`);
    expect(hrefs().some((href) => href?.includes(OTHER))).toBe(false);
  });

  it('keeps an explicit club override ahead of the current route', async () => {
    await renderAt(`/clubs/${CLUB}/cashier`, OTHER);

    expect(hrefs()).toContain(`/clubs/${OTHER}/settings`);
    expect(hrefs().some((href) => href?.includes(CLUB))).toBe(false);
  });

  it('uses real top-level fallbacks when no club can be resolved', async () => {
    await renderAt('/stats');

    expect(hrefs()).toEqual([
      '/settings',
      '/players',
      '/cashier',
      '/marketplace',
      '/data',
      '/stats',
    ]);
    expect(hrefs().some((href) => href?.includes('/clubs//'))).toBe(false);
  });

  it('renders the exact approved artwork with reserved intrinsic dimensions', async () => {
    await renderAt('/', CLUB);

    const artwork = screen.getByRole('presentation');
    expect(artwork).toHaveAttribute('src', '/images/club-footer/club-arena-footer.webp');
    expect(artwork).toHaveAttribute('width', '1916');
    expect(artwork).toHaveAttribute('height', '256');
  });
});
