import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => mocks.toast,
}));

import DiamondsTab from '../../src/pages/marketplace/DiamondsTab';
import MembershipTab from '../../src/pages/marketplace/MembershipTab';
import type {
  DiamondPackage,
  StoreCatalog,
  VipPlan,
  WalletInfo,
} from '../../src/pages/marketplace/marketplaceShared';

const userId = 'fade0000-0000-4000-8000-000000000001';
const clubId = 'fade0000-0000-4000-8000-000000000002';
const wallet: WalletInfo = {
  diamonds: 10_000,
  isVip: false,
  vipTier: null,
  vipExpiresAt: null,
  loaded: true,
  error: null,
};
const diamondPackage: DiamondPackage = {
  id: 'starter',
  name: 'First Stack',
  diamonds: 500,
  bonus: 50,
  priceUsd: 3.99,
  priceCents: 399,
  cardCheckoutReady: true,
  diamondCheckoutReady: false,
};
const monthlyPlan: VipPlan = {
  id: 'vip-monthly',
  planKey: 'monthly',
  checkoutPlan: 'vip-monthly',
  name: 'VIP Monthly',
  period: 'Month',
  priceUsd: 19.99,
  priceDiamonds: 1999,
  features: ['Every VIP Feature'],
  cardCheckoutReady: true,
  diamondCheckoutReady: true,
};
const verifiedCatalog: StoreCatalog = {
  diamondPackages: [diamondPackage],
  vipPlans: [monthlyPlan],
  shopCategories: [
    { name: 'Time Banks', grantType: 'time_bank', grantUnit: 'uses', secondsPerUse: 20 },
    { name: 'Throwables', grantType: 'throwable', grantUnit: 'throws' },
  ],
  fromServer: true,
};

function pretendNative(on: boolean) {
  const browserWindow = window as unknown as { Capacitor?: unknown };
  if (on) {
    browserWindow.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
  } else {
    delete browserWindow.Capacitor;
  }
}

function renderMarketplacePaymentSurfaces() {
  const refreshDiamonds = vi.fn(async () => verifiedCatalog);
  const refreshMembership = vi.fn(async () => verifiedCatalog);
  render(
    <MemoryRouter>
      <DiamondsTab
        clubId={clubId}
        userId={userId}
        wallet={wallet}
        packages={[diamondPackage]}
        catalogVerified
        refreshCatalogForPurchase={refreshDiamonds}
      />
      <MembershipTab
        clubId={clubId}
        userId={userId}
        wallet={wallet}
        plans={[monthlyPlan]}
        catalogVerified
        refreshCatalogForPurchase={refreshMembership}
        onWalletChanged={vi.fn()}
      />
    </MemoryRouter>
  );
  return { refreshDiamonds, refreshMembership };
}

afterEach(() => {
  pretendNative(false);
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe('Marketplace native payment safety hold', () => {
  it('keeps native Card controls unavailable while Diamond-paid VIP remains available', () => {
    pretendNative(true);
    const { refreshDiamonds, refreshMembership } = renderMarketplacePaymentSurfaces();

    expect(screen.getByRole('button', { name: 'Buy 550 Diamonds For $3.99' })).toBeDisabled();
    expect(screen.getByText('App Store Checkout Paused')).toBeVisible();
    expect(
      screen.getByText(
        'App Store Checkout Is Temporarily Unavailable. Use The Web Store Or Pay With Diamonds.'
      )
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Subscribe To VIP Monthly With Card' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Pay 1,999 Diamonds For VIP Monthly' })
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Manage Subscription' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore Purchases' })).toBeDisabled();
    expect(refreshDiamonds).not.toHaveBeenCalled();
    expect(refreshMembership).not.toHaveBeenCalled();
  });

  it('preserves both verified Card rails and Diamond-paid VIP in the browser', () => {
    pretendNative(false);
    renderMarketplacePaymentSurfaces();

    expect(screen.getByRole('button', { name: 'Buy 550 Diamonds For $3.99' })).toBeEnabled();
    expect(screen.getByText('Buy Securely')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Subscribe To VIP Monthly With Card' })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Pay 1,999 Diamonds For VIP Monthly' })
    ).toBeEnabled();
    expect(
      screen.queryByText(/App Store Checkout Is Temporarily Unavailable/)
    ).not.toBeInTheDocument();
  });
});
