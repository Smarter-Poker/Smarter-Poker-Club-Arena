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
 * Two separate failures were behind that sentence and both are pinned here:
 *
 *  1. THE ACTIVE TAB MUST NOT RENDER. It used to render highlighted.
 *  2. THE BAR MUST WORK WITHOUT A clubId PROP. Marketplace and Stats are
 *     top-level routes, so every call site's `{clubId && <ClubBottomNav/>}`
 *     guard meant no footer at all on those pages. The club is resolved from
 *     LAST_CLUB instead.
 *
 * The label text is matched case-insensitively on purpose: the house Title Case
 * rule rewrites forward-facing copy, and pinning casing here would fail on a
 * styling rule rather than on the behaviour this file exists to protect.
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ClubBottomNav from '../../src/components/club/ClubBottomNav';
import { STORAGE_KEYS } from '../../src/lib/storage';

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'user-1' }, loading: false }),
}));

const CLUB = '11111111-2222-3333-4444-555555555555';

/** Tabs are faded in on a stagger; flush the timers so they are visible. */
function renderAt(path: string, props: Record<string, unknown> = {}) {
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
  return view;
}

/** The visible tab labels, in bar order. */
function labels(): string[] {
  return screen
    .queryAllByRole('link')
    .map((a) => (a.textContent || '').trim().toLowerCase())
    .filter(Boolean);
}

const ALL = ['profile', 'players', 'cashier', 'market', 'data', 'stats'];

describe('ClubBottomNav - the current page is not offered', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEYS.LAST_CLUB, CLUB);
  });

  it.each([
    [`/clubs/${CLUB}/settings`, 'profile'],
    [`/clubs/${CLUB}/members`, 'players'],
    [`/clubs/${CLUB}/cashier`, 'cashier'],
    ['/marketplace', 'market'],
    [`/clubs/${CLUB}/dashboard`, 'data'],
    ['/stats', 'stats'],
  ])('on %s the %s tab is omitted and the other five remain', (path, hidden) => {
    renderAt(path, { clubId: path.includes('/clubs/') ? CLUB : undefined });
    const shown = labels();
    expect(shown).not.toContain(hidden);
    expect(shown.sort()).toEqual(ALL.filter((l) => l !== hidden).sort());
  });

  it('renders every tab on a route that is none of the six', () => {
    renderAt('/', { clubId: CLUB });
    expect(labels().sort()).toEqual([...ALL].sort());
  });
});

describe('ClubBottomNav - top-level routes still get a footer', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('resolves the club from LAST_CLUB when no clubId prop is given', () => {
    localStorage.setItem(STORAGE_KEYS.LAST_CLUB, CLUB);
    renderAt('/stats');
    const hrefs = screen.queryAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`/clubs/${CLUB}/settings`);
    expect(hrefs).toContain(`/clubs/${CLUB}/cashier`);
    expect(hrefs).toContain(`/clubs/${CLUB}/dashboard`);
    // The page you are on is never one of the offered destinations.
    expect(hrefs).not.toContain('/stats');
  });

  it('never emits a club link with an empty id when no club can be resolved', () => {
    renderAt('/stats');
    const hrefs = screen.queryAllByRole('link').map((a) => a.getAttribute('href') || '');
    expect(hrefs.some((h) => h.startsWith('/clubs//'))).toBe(false);
  });
});
