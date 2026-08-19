/**
 * CashierClubSwitcher — the in-cashier club context bar + dropdown.
 * Covers: warm-cache rendering, switching navigates to the other club's
 * cashier, cold-cache membership fetch fallback, and single-club static chip.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const eqMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: eqMock })),
    })),
  },
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'test-user-123' } }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

import CashierClubSwitcher from '@/components/club/CashierClubSwitcher';
import { clearClubChipBalanceCache } from '@/utils/clubQuickLink';
import { STORAGE_KEYS } from '@/lib/storage';

const A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha Club', club_id: 11111 };
const B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Bravo Club', club_id: 22222 };

function renderSwitcher(clubId: string, clubName?: string) {
  return render(
    <MemoryRouter>
      <CashierClubSwitcher clubId={clubId} clubName={clubName} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  clearClubChipBalanceCache();
  eqMock.mockReset();
  navigateMock.mockReset();
  eqMock.mockResolvedValue({ data: [], error: null });
});

describe('CashierClubSwitcher', () => {
  it('shows the current club and switches to another club cashier', async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    renderSwitcher(A.id);

    const trigger = screen.getByRole('button', { name: /Current club: Alpha Club/ });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: /Bravo Club/ }));
    expect(navigateMock).toHaveBeenCalledWith(`/clubs/${B.id}/cashier`);
  });

  it('selecting the current club closes without navigating', async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    renderSwitcher(A.id);

    await user.click(screen.getByRole('button', { name: /Current club: Alpha Club/ }));
    await user.click(screen.getByRole('menuitem', { name: /Alpha Club/ }));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('resolves numeric club-code route params against the cache', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    renderSwitcher('22222');
    expect(screen.getByRole('button', { name: /Current club: Bravo Club/ })).toBeInTheDocument();
  });

  it('renders a static chip (no dropdown) for single-club users', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A]));
    renderSwitcher(A.id);
    expect(screen.getByText('Alpha Club')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch club/ })).not.toBeInTheDocument();
  });

  it('cold cache: fetches memberships so switching still works', async () => {
    eqMock.mockResolvedValue({ data: [{ club: A }, { club: B }], error: null });
    renderSwitcher(A.id, 'Alpha Club');
    expect(
      await screen.findByRole('button', { name: /Current club: Alpha Club/ })
    ).toBeInTheDocument();
  });
});
