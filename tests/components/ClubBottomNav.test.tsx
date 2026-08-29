/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB BOTTOM NAV — "every page except the one you just opened" (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, binding: "When I click any of the pages on the bottom and that page
 * opens up, it should have all the other remaining footer options (except the
 * page you just opened) on the bottom. Currently when you open them, there is
 * no footer attached to go to the other pages."
 *
 * Three separate failures were behind that sentence and all are pinned here:
 *
 *  1. THE ACTIVE TAB MUST NOT RENDER. It used to render highlighted.
 *  2. THE BAR MUST WORK WITHOUT A clubId PROP. Marketplace and Stats are
 *     top-level routes, so every call site's `{clubId && <ClubBottomNav/>}`
 *     guard meant no footer at all on those pages.
 *  3. THE ACTIVE TAB MUST BE MATCHED ON SEGMENTS. Because the matched tab is
 *     REMOVED, a false positive silently deletes a destination - and the old
 *     `path.includes('/dashboard')` matched /agent-dashboard, /union-dashboard
 *     and /settlement-dashboard, while `includes('/admin')` matched the
 *     platform console and deleted Settings there.
 *
 * Label text is matched case-insensitively on purpose: the house Title Case
 * rule rewrites forward-facing copy, and pinning casing here would fail on a
 * styling rule rather than on the behaviour this file exists to protect.
 */

import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ClubBottomNav from '../../src/components/club/ClubBottomNav';
import { activeTabForPath } from '../../src/components/club/clubBottomNavTabs';
import { STORAGE_KEYS } from '../../src/lib/storage';

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'user-1' }, loading: false }),
}));

/**
 * The cold-cache path calls fetchQuickLinkClubs, which hits Supabase. Left
 * unmocked it makes a real request from a unit test and settles after the
 * assertions, which is where the "update not wrapped in act" warnings came
 * from. An empty membership list is the case these tests care about anyway.
 */
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        const chain: any = {
          eq: () => chain,
          in: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({
            data: { role: table === 'club_members' ? 'owner' : 'user' },
            error: null,
          }),
        };
        return chain;
      },
    }),
  },
}));

const CLUB = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

/** Seed the lobby cache so resolveTargetClub has a membership to check against. */
function seedClubs(ids: string[] = [CLUB], last: string | null = CLUB) {
  localStorage.setItem(
    STORAGE_KEYS.CLUBS_CACHE,
    JSON.stringify(ids.map((id) => ({ id, name: id, is_union: false })))
  );
  if (last) localStorage.setItem(STORAGE_KEYS.LAST_CLUB, last);
}

/**
 * Tabs fade in on a stagger, and the cold-cache club lookup settles on a
 * microtask. Flush BOTH before asserting - otherwise half the bar is still at
 * opacity 0 and React logs "update not wrapped in act" after the test ends.
 */
async function renderAt(path: string, props: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <ClubBottomNav {...props} />
    </MemoryRouter>
  );
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  vi.useRealTimers();
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

const labels = (): string[] =>
  screen
    .queryAllByRole('link')
    .map((a) => (a.textContent || '').trim().toLowerCase())
    .filter(Boolean);

const hrefs = (): string[] =>
  screen.queryAllByRole('link').map((a) => a.getAttribute('href') || '');

const ALL = ['settings', 'players', 'cashier', 'market', 'data', 'stats'];

describe('activeTabForPath - segments, not substrings', () => {
  it.each([
    [`/clubs/${CLUB}/settings`, 'profile'],
    [`/clubs/${CLUB}/members`, 'players'],
    [`/clubs/${CLUB}/members/u1/statistics`, 'players'],
    ['/players', 'players'],
    [`/clubs/${CLUB}/cashier`, 'cashier'],
    [`/clubs/${CLUB}/cashier-classic`, 'cashier'],
    ['/marketplace', 'marketplace'],
    [`/clubs/${CLUB}/dashboard`, 'data'],
    [`/clubs/${CLUB}/dashboard-full`, 'data'],
    [`/clubs/${CLUB}/data`, 'data'],
    ['/stats', 'stats'],
    ['/stats/someone-else', 'stats'],
  ])('%s is the %s tab', (path, expected) => {
    expect(activeTabForPath(path)).toBe(expected);
  });

  it.each([
    // These are DIFFERENT pages. A substring match swallowed every one of
    // them, and a swallowed match deletes that tab from the bar.
    ['/admin'],
    ['/agent-dashboard'],
    [`/clubs/${CLUB}/agent-dashboard`],
    ['/settlement-dashboard'],
    ['/rakeback-dashboard'],
    ['/union-dashboard'],
    ['/player-sessions'],
    [`/clubs/${CLUB}/settlement`],
    ['/'],
    [`/clubs/${CLUB}`],
  ])('%s matches no tab, so nothing is hidden there', (path) => {
    expect(activeTabForPath(path)).toBeNull();
  });
});

describe('ClubBottomNav - the current page is not offered', () => {
  beforeEach(() => {
    localStorage.clear();
    seedClubs();
  });

  it.each([
    [`/clubs/${CLUB}/settings`, 'settings'],
    [`/clubs/${CLUB}/members`, 'players'],
    [`/clubs/${CLUB}/cashier`, 'cashier'],
    ['/marketplace', 'market'],
    [`/clubs/${CLUB}/dashboard`, 'data'],
    ['/stats', 'stats'],
  ])('on %s the %s tab is omitted and the other five remain', async (path, hidden) => {
    await renderAt(path, { clubId: path.includes('/clubs/') ? CLUB : undefined });
    const shown = labels();
    expect(shown).not.toContain(hidden);
    expect([...shown].sort()).toEqual(ALL.filter((l) => l !== hidden).sort());
  });

  it('renders every tab on a route that is none of the six', async () => {
    await renderAt('/', { clubId: CLUB });
    expect([...labels()].sort()).toEqual([...ALL].sort());
  });

  it('is a labelled list, so a screen reader announces it as navigation', async () => {
    await renderAt('/', { clubId: CLUB });
    expect(screen.getByRole('navigation', { name: /club sections/i })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
  });
});

describe('ClubBottomNav - top-level routes still get a footer', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('resolves the club from the lobby cache when no clubId prop is given', async () => {
    seedClubs();
    await renderAt('/stats');
    expect(hrefs()).toContain(`/clubs/${CLUB}/settings`);
    expect(hrefs()).toContain(`/clubs/${CLUB}/cashier`);
    expect(hrefs()).toContain(`/clubs/${CLUB}/data`);
    // The page you are on is never one of the offered destinations.
    expect(hrefs()).not.toContain('/stats');
  });

  it('falls back to the first club when the last-visited one is no longer yours', async () => {
    // LAST_CLUB points at a club that is not in the membership cache - the
    // shared resolveTargetClub rule drops it rather than linking into a club
    // the player was removed from.
    seedClubs([OTHER], CLUB);
    await renderAt('/marketplace');
    expect(hrefs()).toContain(`/clubs/${OTHER}/settings`);
    expect(hrefs().some((h) => h.includes(CLUB))).toBe(false);
  });

  it('never emits a club link with an empty id when no club can be resolved', async () => {
    await renderAt('/stats');
    expect(hrefs().some((h) => h.startsWith('/clubs//'))).toBe(false);
    // Only the club-less destination survives, and Stats itself is the page
    // we are on, so the bar collapses to Market rather than showing dead tabs.
    expect(labels()).toEqual(['market']);
  });

  it('degrades to the club-less destinations rather than disappearing', async () => {
    // A player with no club at all still gets the tabs that do not need one.
    // On /marketplace that is Stats alone, which is a thin bar but a real way
    // out; the alternative was five tabs pointing at '/clubs//...'.
    await renderAt('/marketplace');
    expect(labels()).toEqual(['stats']);
    expect(hrefs()).toEqual(['/stats']);
  });
});
