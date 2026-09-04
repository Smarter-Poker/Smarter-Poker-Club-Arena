import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadStoreCatalog: vi.fn(),
  startCheckout: vi.fn(),
  close: vi.fn(),
  toast: { error: vi.fn() },
}));

vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/pages/marketplace/marketplaceShared', () => ({
  loadStoreCatalog: mocks.loadStoreCatalog,
  startCheckout: mocks.startCheckout,
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
      popular: true,
    },
  ],
};

describe('DiamondTopUpModal secure checkout contract', () => {
  beforeEach(() => {
    mocks.loadStoreCatalog.mockReset();
    mocks.loadStoreCatalog.mockResolvedValue(catalog);
    mocks.startCheckout.mockReset();
    mocks.startCheckout.mockResolvedValue(undefined);
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
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close Diamond Store' })).toHaveFocus()
    );
  });

  it('starts Stripe checkout with only the selected server catalog id', async () => {
    render(<DiamondTopUpModal isOpen onClose={mocks.close} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Buy First Stack, 550 Diamonds For $3.99',
      })
    );

    await waitFor(() =>
      expect(mocks.startCheckout).toHaveBeenCalledWith(
        'diamonds',
        [{ packageId: 'starter', quantity: 1 }],
        'from=vip'
      )
    );
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
        'from=table-studio'
      )
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
