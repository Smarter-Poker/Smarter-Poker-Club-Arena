/**
 * ChipPurchaseModal — chips are bought INTO A CLUB.
 *
 * The purchase-chips route branches on clubId: with it, fn_purchase_club_chips
 * credits club_members.chip_balance for that club; without it, the legacy
 * fn_purchase_chips credits the GLOBAL player wallet, which the shop, buy-ins
 * and the cashier never read. The route was made club-scoped on 2026-08-19 but
 * the client never sent the id, so purchases charged diamonds and credited a
 * balance nothing spends. These cases pin the client half.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const callApiMock = vi.fn();
vi.mock('@/services/clubArenaApi', () => ({
  callClubArenaApi: (...args: unknown[]) => callApiMock(...args),
  default: (...args: unknown[]) => callApiMock(...args),
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'test-user-123' } }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/components/common/Toast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

// The package list is no longer hardcoded in the component — it is fetched
// from the shared store catalog, so the catalog is stubbed here.
vi.mock('@/pages/marketplace/marketplaceShared', () => ({
  loadStoreCatalog: async () => ({
    chipPackages: [
      { id: 'small', chips: 1000, diamonds: 10 },
      { id: 'large', chips: 10000, diamonds: 80, popular: true },
    ],
  }),
}));

import { ChipPurchaseModal } from '@/components/wallet/ChipPurchaseModal';

const CLUB = 'aaaaaaaa-0000-0000-0000-000000000001';

beforeEach(() => {
  callApiMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  navigateMock.mockReset();
  callApiMock.mockResolvedValue({
    chipsCredited: 1000,
    diamondsCharged: 10,
    diamondBalanceAfter: 90,
  });
});

describe('ChipPurchaseModal', () => {
  it('sends clubId so the chips land in this club, not the global wallet', async () => {
    const user = userEvent.setup();
    render(
      <ChipPurchaseModal isOpen onClose={vi.fn()} currentDiamonds={500} clubId={CLUB} />
    );
    await user.click(await screen.findByRole('button', { name: /Buy 1,000 chips/ }));
    expect(callApiMock).toHaveBeenCalledWith('purchase-chips', {
      packageId: 'small',
      clubId: CLUB,
    });
  });

  it('omits clubId entirely when there is no club (legacy global behaviour)', async () => {
    const user = userEvent.setup();
    render(<ChipPurchaseModal isOpen onClose={vi.fn()} currentDiamonds={500} />);
    await user.click(await screen.findByRole('button', { name: /Buy 1,000 chips/ }));
    expect(callApiMock).toHaveBeenCalledWith('purchase-chips', { packageId: 'small' });
  });

  it('reports the diamond balance the SERVER returned, not a client guess', async () => {
    const user = userEvent.setup();
    const onPurchase = vi.fn();
    render(
      <ChipPurchaseModal
        isOpen
        onClose={vi.fn()}
        currentDiamonds={100}
        clubId={CLUB}
        onPurchase={onPurchase}
      />
    );
    await user.click(await screen.findByRole('button', { name: /Buy 1,000 chips/ }));
    // chips credited, then the authoritative post-purchase diamond balance.
    // Subtracting the CHIP count from the diamond balance (the previous
    // caller-side guess) would have produced a nonsense figure.
    expect(onPurchase).toHaveBeenCalledWith(1000, 90);
  });

  it('surfaces the server error text instead of a generic failure', async () => {
    const user = userEvent.setup();
    callApiMock.mockRejectedValue(new Error('Insufficient diamonds'));
    render(
      <ChipPurchaseModal isOpen onClose={vi.fn()} currentDiamonds={500} clubId={CLUB} />
    );
    await user.click(await screen.findByRole('button', { name: /Buy 1,000 chips/ }));
    expect(toastError).toHaveBeenCalledWith('Insufficient diamonds');
  });

  it('states the price is in diamonds', async () => {
    render(<ChipPurchaseModal isOpen onClose={vi.fn()} currentDiamonds={500} clubId={CLUB} />);
    expect(await screen.findByText('10 diamonds')).toBeInTheDocument();
  });

  it('the Get Diamonds button actually goes somewhere', async () => {
    const user = userEvent.setup();
    render(<ChipPurchaseModal isOpen onClose={vi.fn()} currentDiamonds={500} clubId={CLUB} />);
    await user.click(await screen.findByRole('button', { name: /Get Diamonds/ }));
    expect(navigateMock).toHaveBeenCalledWith('/vip');
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ChipPurchaseModal isOpen={false} onClose={vi.fn()} currentDiamonds={500} clubId={CLUB} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
