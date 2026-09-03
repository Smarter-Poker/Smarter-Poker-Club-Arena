/**
 * CashierClubSwitcher — the in-cashier club context bar + dropdown.
 * Covers: warm-cache rendering, switching navigates to the other club's
 * cashier, cold-cache membership fetch fallback, union exclusion, per-club
 * balances, and the single-club static chip.
 */

// Case-insensitive text matchers on purpose: Dan's house rule Title Cases every
// word on every forward-facing page (scripts/ci/check-title-case.mjs), so pinning
// the casing of copy makes these fail on a styling rule rather than on the
// behaviour they exist to protect. The words are the contract.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const inMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ in: inMock })) })),
    })),
  },
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'test-user-123' } }),
}));

vi.mock('@/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: vi.fn(),
  useMasterBusSubscriptions: vi.fn(),
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
const UNION = {
  id: 'cccccccc-0000-0000-0000-000000000003',
  name: 'Midway Alliance',
  club_id: 55555,
  is_union: true,
};

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
  inMock.mockReset();
  navigateMock.mockReset();
  inMock.mockResolvedValue({ data: [], error: null });
});

describe('CashierClubSwitcher', () => {
  it('shows the current club and switches to another club cashier', async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    renderSwitcher(A.id);

    await user.click(screen.getByRole('button', { name: /Current Club: Alpha Club/ }));
    await user.click(screen.getByRole('menuitem', { name: /Bravo Club/ }));
    expect(navigateMock).toHaveBeenCalledWith(`/clubs/${B.id}/cashier`);
  });

  it('selecting the current club closes without navigating', async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    renderSwitcher(A.id);

    await user.click(screen.getByRole('button', { name: /Current Club: Alpha Club/ }));
    await user.click(screen.getByRole('menuitem', { name: /Alpha Club/ }));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows each club chip balance in the dropdown', async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    inMock.mockResolvedValue({
      data: [
        { club_id: A.id, chip_balance: 4200 },
        { club_id: B.id, chip_balance: 15 },
      ],
      error: null,
    });
    renderSwitcher(A.id);
    await user.click(screen.getByRole('button', { name: /Current Club: Alpha Club/ }));
    expect(
      await screen.findByText(new RegExp(`${(4200).toLocaleString()} Chips`, 'i'))
    ).toBeInTheDocument();
    expect(screen.getByText(/15 chips/i)).toBeInTheDocument();
  });

  it('never offers a union as a cashier destination', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, UNION]));
    renderSwitcher(A.id);
    // Only one eligible club remains, so it degrades to the static chip
    expect(screen.queryByRole('button', { name: /Switch club cashier/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Midway Alliance')).not.toBeInTheDocument();
  });

  it('resolves numeric club-code route params against the cache', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    renderSwitcher('22222');
    expect(screen.getByRole('button', { name: /Current Club: Bravo Club/ })).toBeInTheDocument();
  });

  it('renders a static chip (no dropdown) for single-club users', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A]));
    renderSwitcher(A.id);
    expect(screen.getByText('Alpha Club')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch club/ })).not.toBeInTheDocument();
  });

  it('cold cache: fetches memberships so switching still works', async () => {
    inMock.mockResolvedValue({ data: [{ club: A }, { club: B }], error: null });
    renderSwitcher(A.id, 'Alpha Club');
    expect(
      await screen.findByRole('button', { name: /Current Club: Alpha Club/ })
    ).toBeInTheDocument();
  });

  it('records the resolved club as last-visited (numeric deep-link gap)', async () => {
    inMock.mockResolvedValue({ data: [{ club: A }, { club: B }], error: null });
    renderSwitcher('22222', 'Bravo Club');
    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEYS.LAST_CLUB)).toBe(B.id);
    });
  });

  it('renders nothing when there is no club to show at all', async () => {
    const { container } = renderSwitcher('99999');
    expect(container).toBeEmptyDOMElement();
    await act(async () => {}); // flush the cold-cache fetch
  });
});
