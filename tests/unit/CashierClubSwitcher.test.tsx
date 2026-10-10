/**
 * CashierClubSwitcher keeps the viewer on the cashier surface they are on
 * (launch audit 2026-10-09, P-08). It always navigated to `/cashier`, the
 * Trade grid, so an owner on the classic cashier's Mint or History tab who
 * picked another club lost the classic page.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CashierClubSwitcher, {
  cashierDestination,
} from '../../src/components/club/CashierClubSwitcher';

const USER = '22222222-2222-4222-8222-222222222222';
const CLUB_A = '11111111-1111-4111-8111-111111111111';
const CLUB_B = '33333333-3333-4333-8333-333333333333';

vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: USER } }) }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: () => {},
}));
vi.mock('../../src/services/HapticService', () => ({
  default: { light: vi.fn(), medium: vi.fn(), heavy: vi.fn() },
}));
vi.mock('../../src/utils/clubQuickLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubQuickLink')>()),
  readCachedQuickLinkClubs: () => [
    { id: CLUB_A, name: 'Shark Club', club_id: 100001 },
    { id: CLUB_B, name: 'Whale Club', club_id: 100002 },
  ],
  fetchQuickLinkClubsResult: async () => ({ clubs: [], ok: true }),
  fetchClubChipBalances: async () => new Map(),
  clearClubChipBalanceCache: vi.fn(),
  rememberLastClub: vi.fn(),
  CHIP_BALANCE_EVENTS: [],
}));

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function start(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/clubs/:clubId/*"
          element={
            <>
              <CashierClubSwitcher clubId={CLUB_A} clubName="Shark Club" />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

async function pickWhaleClub() {
  fireEvent.click(await screen.findByRole('button', { name: /Switch Club Cashier/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Whale Club/ }));
}

describe('CashierClubSwitcher destination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cashierDestination maps each cashier surface to itself', () => {
    expect(cashierDestination(`/clubs/${CLUB_A}/cashier-classic`)).toBe('cashier-classic');
    expect(cashierDestination(`/clubs/${CLUB_A}/cashier-classic/`)).toBe('cashier-classic');
    expect(cashierDestination(`/clubs/${CLUB_A}/cashier/statements`)).toBe('cashier/statements');
    expect(cashierDestination(`/clubs/${CLUB_A}/cashier`)).toBe('cashier');
    expect(cashierDestination('/cashier')).toBe('cashier');
    expect(cashierDestination('/clubs/x/cashier-classic-old')).toBe('cashier');
  });

  it('keeps the viewer on the classic cashier when switching from it', async () => {
    start(`/clubs/${CLUB_A}/cashier-classic`);
    await pickWhaleClub();
    expect(screen.getByTestId('where')).toHaveTextContent(`/clubs/${CLUB_B}/cashier-classic`);
  });

  it('keeps the viewer on the statements page when switching from it', async () => {
    start(`/clubs/${CLUB_A}/cashier/statements`);
    await pickWhaleClub();
    expect(screen.getByTestId('where')).toHaveTextContent(`/clubs/${CLUB_B}/cashier/statements`);
  });

  it('sends the viewer to the Trade cashier from anywhere else', async () => {
    start(`/clubs/${CLUB_A}/cashier`);
    await pickWhaleClub();
    expect(screen.getByTestId('where')).toHaveTextContent(`/clubs/${CLUB_B}/cashier`);
    expect(screen.getByTestId('where')).not.toHaveTextContent('cashier-classic');
  });
});
