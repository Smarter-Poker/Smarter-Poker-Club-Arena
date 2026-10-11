/**
 * CashierClubSwitcher on a SLUG route (cashier launch audit C1-18, 2026-10-09).
 *
 * Every link the switcher builds uses the club's slug, but the current club was
 * matched by uuid or numeric code only. On /clubs/<slug>/cashier-classic no row
 * was marked current, and choosing the club you were already in navigated away
 * from the Advanced Cashier to the Trade cashier.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
import { clearClubChipBalanceCache, writeCachedQuickLinkClubs } from '@/utils/clubQuickLink';

const A = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: 'Alpha Club',
  club_id: 11111,
  slug: 'alpha-club',
};
const B = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  name: 'Bravo Club',
  club_id: 22222,
  slug: 'bravo-club',
};

beforeEach(() => {
  localStorage.clear();
  clearClubChipBalanceCache();
  inMock.mockReset();
  navigateMock.mockReset();
  inMock.mockResolvedValue({ data: [], error: null });
});

describe('CashierClubSwitcher on a slug route', () => {
  it('recognises the current club by its slug and does not navigate away from it', async () => {
    const user = userEvent.setup();
    writeCachedQuickLinkClubs('test-user-123', [A, B]);
    render(
      <MemoryRouter>
        <CashierClubSwitcher clubId={A.slug} clubName="Alpha Club" />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: /Current Club: Alpha Club/ }));
    await user.click(screen.getByRole('menuitem', { name: /Alpha Club/ }));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('still opens another club at its Trade cashier', async () => {
    const user = userEvent.setup();
    writeCachedQuickLinkClubs('test-user-123', [A, B]);
    render(
      <MemoryRouter>
        <CashierClubSwitcher clubId={A.slug} clubName="Alpha Club" />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: /Current Club: Alpha Club/ }));
    await user.click(screen.getByRole('menuitem', { name: /Bravo Club/ }));
    expect(navigateMock).toHaveBeenCalledWith(`/clubs/${B.slug}/cashier`);
  });
});
