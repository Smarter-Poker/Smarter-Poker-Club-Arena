import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  diamondCheckoutOfferConfirmation: vi.fn(),
  checkoutProviderReadyForCurrentPlatform: vi.fn(),
  loadStoreCatalog: vi.fn(),
  startCheckout: vi.fn(),
  marketplacePurchaseScope: vi.fn(),
  readOrCreateMarketplacePurchaseIntent: vi.fn(),
  retireMarketplacePurchaseIntent: vi.fn(),
  isVerifiedCheckoutPrecommitRefusal: vi.fn(),
  isVerifiedCheckoutTerminalExpiration: vi.fn(),
  auth: {
    user: { id: 'fade0000-0000-4000-8000-000000000001' } as { id: string } | null,
  },
  close: vi.fn(),
  toast: { error: vi.fn() },
}));

vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.auth.user, isAuthenticated: Boolean(mocks.auth.user) }),
}));
vi.mock('../../src/pages/marketplace/marketplaceShared', () => ({
  diamondCheckoutOfferConfirmation: mocks.diamondCheckoutOfferConfirmation,
  checkoutProviderReadyForCurrentPlatform: mocks.checkoutProviderReadyForCurrentPlatform,
  isVerifiedCheckoutPrecommitRefusal: mocks.isVerifiedCheckoutPrecommitRefusal,
  isVerifiedCheckoutTerminalExpiration: mocks.isVerifiedCheckoutTerminalExpiration,
  loadStoreCatalog: mocks.loadStoreCatalog,
  marketplacePurchaseScope: mocks.marketplacePurchaseScope,
  readOrCreateMarketplacePurchaseIntent: mocks.readOrCreateMarketplacePurchaseIntent,
  retireMarketplacePurchaseIntent: mocks.retireMarketplacePurchaseIntent,
  startCheckout: mocks.startCheckout,
  NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE:
    'App Store Checkout Is Temporarily Unavailable. Use The Web Store Or Pay With Diamonds.',
}));

import { DiamondTopUpModal } from '../../src/components/vip/DiamondTopUpModal';

const catalog = {
  fromServer: true,
  diamondPackages: [
    {
      id: 'starter',
      name: 'First Stack',
      diamonds: 500,
      bonus: 50,
      priceUsd: 3.99,
      priceCents: 399,
      popular: true,
      cardCheckoutReady: true,
      diamondCheckoutReady: false,
    },
  ],
};

const fallbackCatalog = {
  ...catalog,
  fromServer: false,
};

const requestId = 'fade0000-0000-4000-8000-000000000099';
const offerConfirmation = {
  version: 1,
  accountId: 'fade0000-0000-4000-8000-000000000001',
  type: 'diamonds',
  currency: 'usd',
  totalCents: 399,
  totalDiamonds: 500,
  totalBonus: 50,
  items: [{ packageId: 'starter', quantity: 1, unitCents: 399, diamonds: 500, bonus: 50 }],
};
const purchaseScope =
  'marketplace:diamond-package-card:fade0000-0000-4000-8000-000000000001:starter';

describe('DiamondTopUpModal secure checkout contract', () => {
  beforeEach(() => {
    mocks.diamondCheckoutOfferConfirmation.mockReset();
    mocks.diamondCheckoutOfferConfirmation.mockReturnValue(offerConfirmation);
    mocks.checkoutProviderReadyForCurrentPlatform.mockReset();
    mocks.checkoutProviderReadyForCurrentPlatform.mockReturnValue(true);
    mocks.loadStoreCatalog.mockReset();
    mocks.loadStoreCatalog.mockResolvedValue(catalog);
    mocks.startCheckout.mockReset();
    mocks.startCheckout.mockResolvedValue(undefined);
    mocks.marketplacePurchaseScope.mockReset();
    mocks.marketplacePurchaseScope.mockReturnValue(purchaseScope);
    mocks.readOrCreateMarketplacePurchaseIntent.mockReset();
    mocks.readOrCreateMarketplacePurchaseIntent.mockReturnValue({
      requestId,
      payloadKey: 'terms',
      resumed: false,
    });
    mocks.retireMarketplacePurchaseIntent.mockReset();
    mocks.retireMarketplacePurchaseIntent.mockReturnValue(true);
    mocks.isVerifiedCheckoutPrecommitRefusal.mockReset();
    mocks.isVerifiedCheckoutPrecommitRefusal.mockReturnValue(false);
    mocks.isVerifiedCheckoutTerminalExpiration.mockReset();
    mocks.isVerifiedCheckoutTerminalExpiration.mockReturnValue(false);
    mocks.auth.user = { id: 'fade0000-0000-4000-8000-000000000001' };
    mocks.close.mockReset();
    mocks.toast.error.mockReset();
    document.body.style.overflow = '';
  });

  it('is a trapped modal and labels the exact server-priced package', async () => {
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);

    expect(screen.getByRole('dialog', { name: 'Add Diamonds' })).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    const purchase = await screen.findByRole('button', {
      name: 'Buy First Stack, 550 Diamonds For $3.99',
    });
    await waitFor(() => expect(purchase).toBeEnabled());
    expect(screen.getByText('Server-Priced')).toBeVisible();
    const premiumArt = document.querySelector<HTMLElement>('.diamond-package__art');
    expect(premiumArt).not.toBeNull();
    expect(premiumArt).toHaveAttribute('data-tier', '0');
    expect(premiumArt?.style.getPropertyValue('--diamond-package-atlas')).toContain(
      'images/marketplace/diamond-packages/diamond-package-atlas-v1.webp'
    );
    expect(document.querySelector('.diamond-package__icon')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close Diamond Store' })).toHaveFocus()
    );
  });

  it('contains keyboard focus, closes with Escape, and restores the opener and page scroll', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open Diamond Store';
    document.body.appendChild(opener);
    opener.focus();
    document.body.style.overflow = 'auto';

    const view = render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    const close = screen.getByRole('button', { name: 'Close Diamond Store' });
    const purchase = await screen.findByRole('button', {
      name: 'Buy First Stack, 550 Diamonds For $3.99',
    });
    await waitFor(() => expect(purchase).toBeEnabled());
    await waitFor(() => expect(close).toHaveFocus());
    expect(document.body.style.overflow).toBe('hidden');

    purchase.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(purchase).toHaveFocus();

    const replacementClose = vi.fn();
    view.rerender(<DiamondTopUpModal isOpen onClose={replacementClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mocks.close).not.toHaveBeenCalled();
    expect(replacementClose).toHaveBeenCalledTimes(1);
    view.rerender(<DiamondTopUpModal isOpen={false} onClose={replacementClose} />);

    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe('auto');
    opener.remove();
  });

  it('Title Cases A Server Package Name In Visible And Accessible Copy', async () => {
    mocks.loadStoreCatalog.mockResolvedValueOnce({
      ...catalog,
      diamondPackages: [{ ...catalog.diamondPackages[0], name: 'first stack' }],
    });
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);

    expect(await screen.findByText('First Stack')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Buy First Stack, 550 Diamonds For $3.99' })
    ).toBeVisible();
  });

  it('forces current pricing and persists exact terms before starting checkout', async () => {
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );

    await waitFor(() => {
      expect(mocks.loadStoreCatalog).toHaveBeenCalledTimes(2);
      expect(mocks.loadStoreCatalog).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ force: true, signal: expect.any(AbortSignal) })
      );
      expect(mocks.loadStoreCatalog).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ force: true, signal: expect.any(AbortSignal) })
      );
      expect(mocks.marketplacePurchaseScope).toHaveBeenCalledWith(
        'fade0000-0000-4000-8000-000000000001',
        'diamond-package-card',
        'starter'
      );
      expect(mocks.readOrCreateMarketplacePurchaseIntent).toHaveBeenCalledWith(
        purchaseScope,
        JSON.stringify({
          version: 1,
          type: 'diamonds',
          packageId: 'starter',
          quantity: 1,
          diamonds: 500,
          bonus: 50,
          priceUsd: 3.99,
          priceCents: 399,
        })
      );
      expect(mocks.startCheckout).toHaveBeenCalledWith(
        'diamonds',
        [{ packageId: 'starter', quantity: 1 }],
        'from=vip',
        {
          requestId,
          expectedUserId: 'fade0000-0000-4000-8000-000000000001',
          offerConfirmation,
          signal: expect.any(AbortSignal),
        }
      );
      expect(mocks.readOrCreateMarketplacePurchaseIntent.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.startCheckout.mock.invocationCallOrder[0]
      );
      expect(mocks.retireMarketplacePurchaseIntent).not.toHaveBeenCalled();
    });
  });

  it('returns Stripe to the requesting customization surface', async () => {
    render(<DiamondTopUpModal isOpen onClose={mocks.close} returnParams="from=table-studio" />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );

    await waitFor(() =>
      expect(mocks.startCheckout).toHaveBeenCalledWith(
        'diamonds',
        [{ packageId: 'starter', quantity: 1 }],
        'from=table-studio',
        {
          requestId,
          expectedUserId: 'fade0000-0000-4000-8000-000000000001',
          offerConfirmation,
          signal: expect.any(AbortSignal),
        }
      )
    );
  });

  it('renders bundled package copy as disabled when live catalog proof is unavailable', async () => {
    mocks.loadStoreCatalog.mockResolvedValue(fallbackCatalog);
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);

    const purchase = await screen.findByRole('button', {
      name: 'Buy First Stack, 550 Diamonds For $3.99',
    });
    await waitFor(() => expect(purchase).toBeDisabled());
    expect(screen.getByRole('alert')).toHaveTextContent('Packages Are Display Only');
    fireEvent.click(purchase);
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.readOrCreateMarketplacePurchaseIntent).not.toHaveBeenCalled();
  });

  it('renders verified packages as display only when native provider safety is held', async () => {
    mocks.checkoutProviderReadyForCurrentPlatform.mockReturnValue(false);
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);

    const purchase = await screen.findByRole('button', {
      name: 'Buy First Stack, 550 Diamonds For $3.99',
    });
    await waitFor(() => expect(purchase).toBeDisabled());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'App Store Checkout Is Temporarily Unavailable'
    );
    expect(screen.getByText('Web Checkout Available')).toBeVisible();
    expect(screen.queryByText('Secure Checkout')).not.toBeInTheDocument();
    fireEvent.click(purchase);
    expect(mocks.loadStoreCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.readOrCreateMarketplacePurchaseIntent).not.toHaveBeenCalled();
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it('does not trust a malformed package even when a response claims to be live', async () => {
    mocks.loadStoreCatalog.mockResolvedValue({
      ...catalog,
      diamondPackages: [{ ...catalog.diamondPackages[0], priceCents: '399' }],
    });
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);

    expect(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    ).toBeDisabled();
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it('fails closed when the forced purchase-time catalog is unavailable', async () => {
    mocks.loadStoreCatalog.mockResolvedValueOnce(catalog).mockResolvedValueOnce(fallbackCatalog);
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'Live Pricing Could Not Be Verified. No Payment Was Started.'
      )
    );
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.readOrCreateMarketplacePurchaseIntent).not.toHaveBeenCalled();
  });

  it('refreshes changed terms without creating a request for the stale package', async () => {
    const repricedCatalog = {
      ...catalog,
      diamondPackages: [{ ...catalog.diamondPackages[0], priceUsd: 4.99, priceCents: 499 }],
    };
    mocks.loadStoreCatalog.mockResolvedValueOnce(catalog).mockResolvedValueOnce(repricedCatalog);
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'Pricing Was Updated. Review The Current Package Before Purchasing.'
      )
    );
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.readOrCreateMarketplacePurchaseIntent).not.toHaveBeenCalled();
  });

  it('does not start checkout when the exact request cannot be persisted', async () => {
    mocks.readOrCreateMarketplacePurchaseIntent.mockImplementationOnce(() => {
      throw new Error('Protected Purchase Storage Is Unavailable');
    });
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('Protected Purchase Storage Is Unavailable')
    );
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it('does not persist or submit an offer that cannot be bound to the active account', async () => {
    mocks.diamondCheckoutOfferConfirmation.mockReturnValueOnce(null);
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'The Checkout Terms Could Not Be Verified. No Payment Was Started.'
      )
    );
    expect(mocks.readOrCreateMarketplacePurchaseIntent).not.toHaveBeenCalled();
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it('retains an ambiguous request and retires only a verified precommit refusal', async () => {
    mocks.startCheckout.mockRejectedValueOnce(new Error('Connection Lost'));
    const { unmount } = render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Connection Lost'));
    expect(mocks.retireMarketplacePurchaseIntent).not.toHaveBeenCalled();

    unmount();
    mocks.startCheckout.mockRejectedValueOnce(new Error('Invalid Request'));
    mocks.isVerifiedCheckoutPrecommitRefusal.mockReturnValueOnce(true);
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );
    await waitFor(() =>
      expect(mocks.retireMarketplacePurchaseIntent).toHaveBeenCalledWith(purchaseScope, requestId)
    );
  });

  it('retains a resumed Card request unless its provider session is verified expired', async () => {
    mocks.readOrCreateMarketplacePurchaseIntent.mockReturnValue({
      requestId,
      payloadKey: 'terms',
      resumed: true,
    });
    mocks.startCheckout.mockRejectedValueOnce(new Error('Request Conflict'));
    mocks.isVerifiedCheckoutPrecommitRefusal.mockReturnValue(true);

    const { unmount } = render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Request Conflict'));
    expect(mocks.retireMarketplacePurchaseIntent).not.toHaveBeenCalled();

    unmount();
    mocks.startCheckout.mockRejectedValueOnce(new Error('Checkout Expired'));
    mocks.isVerifiedCheckoutTerminalExpiration.mockReturnValue(true);
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );
    await waitFor(() =>
      expect(mocks.retireMarketplacePurchaseIntent).toHaveBeenCalledWith(purchaseScope, requestId)
    );
  });

  it('closes on Escape without leaving page scroll locked', async () => {
    const { unmount } = render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    await screen.findByRole('button', {
      name: 'Buy First Stack, 550 Diamonds For $3.99',
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
