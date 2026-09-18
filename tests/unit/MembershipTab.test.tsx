import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = 'fade0000-0000-4000-8000-000000000001';
const USER_B = 'fade0000-0000-4000-8000-000000000002';

const mocks = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  confirmDialog: vi.fn(),
  emit: vi.fn(),
  checkoutProviderReadyForCurrentPlatform: vi.fn(),
  isNativeMarketplaceRuntime: vi.fn(),
  startCheckout: vi.fn(),
  storeFetch: vi.fn(),
}));

vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/components/common/confirmDialog', () => ({
  confirmDialog: mocks.confirmDialog,
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/pages/marketplace/marketplaceShared', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/pages/marketplace/marketplaceShared')
  >('../../src/pages/marketplace/marketplaceShared');
  return {
    ...actual,
    checkoutProviderReadyForCurrentPlatform: mocks.checkoutProviderReadyForCurrentPlatform,
    isNativeMarketplaceRuntime: mocks.isNativeMarketplaceRuntime,
    startCheckout: mocks.startCheckout,
    storeFetch: mocks.storeFetch,
  };
});

import MembershipTab from '../../src/pages/marketplace/MembershipTab';
import {
  marketplacePurchaseScope,
  readMarketplacePurchaseIntent,
  readOrCreateMarketplacePurchaseIntent,
  retireMarketplacePurchaseIntent,
  vipDiamondOfferConfirmation,
  type StoreCatalog,
  type VipPlan,
  type WalletInfo,
} from '../../src/pages/marketplace/marketplaceShared';

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

const catalog: StoreCatalog = {
  diamondPackages: [],
  vipPlans: [monthlyPlan],
  shopCategories: [
    { name: 'Time Banks', grantType: 'time_bank', grantUnit: 'uses', secondsPerUse: 20 },
    { name: 'Throwables', grantType: 'throwable', grantUnit: 'throws' },
  ],
  fromServer: true,
};

const payloadKey = JSON.stringify({
  version: 1,
  plan: 'monthly',
  id: 'vip-monthly',
  priceDiamonds: 1999,
});

const wallet = (overrides: Partial<WalletInfo> = {}): WalletInfo => ({
  diamonds: 5000,
  isVip: false,
  vipTier: null,
  vipExpiresAt: null,
  loaded: true,
  error: null,
  ...overrides,
});

const receipt = (
  accountId: string,
  requestId: string,
  overrides: Record<string, unknown> = {}
) => ({
  success: true,
  accountId,
  requestId,
  idempotent: false,
  duplicate: false,
  isVip: true,
  plan: 'monthly',
  tier: 'monthly',
  cost: 1999,
  daysAdded: 30,
  expiresAt: '2099-10-15T12:00:00Z',
  newBalance: 3001,
  ...overrides,
});

function renderMembership(
  props: {
    userId?: string;
    wallet?: WalletInfo;
    refreshCatalogForPurchase?: () => Promise<StoreCatalog>;
    onWalletChanged?: () => void;
  } = {}
) {
  return render(
    <MembershipTab
      clubId="club-1"
      userId={props.userId ?? USER_A}
      wallet={props.wallet ?? wallet()}
      plans={[monthlyPlan]}
      catalogVerified
      refreshCatalogForPurchase={props.refreshCatalogForPurchase ?? vi.fn(async () => catalog)}
      onWalletChanged={props.onWalletChanged ?? vi.fn()}
    />
  );
}

describe('MembershipTab protected VIP purchase recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.checkoutProviderReadyForCurrentPlatform.mockReturnValue(false);
    mocks.isNativeMarketplaceRuntime.mockReturnValue(false);
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.startCheckout.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it('keeps an exact pending purchase actionable after both a debit and Lifetime status', async () => {
    const scope = marketplacePurchaseScope(USER_A, 'vip-diamonds', 'monthly');
    readOrCreateMarketplacePurchaseIntent(scope, payloadKey);
    const view = renderMembership({ wallet: wallet({ diamonds: 0 }) });

    expect(
      await screen.findByRole('button', { name: 'Verify Pending VIP Monthly Purchase' })
    ).toBeEnabled();

    view.rerender(
      <MembershipTab
        clubId="club-1"
        userId={USER_A}
        wallet={wallet({ diamonds: 0, isVip: true, vipTier: 'lifetime' })}
        plans={[monthlyPlan]}
        catalogVerified
        refreshCatalogForPurchase={vi.fn(async () => catalog)}
        onWalletChanged={vi.fn()}
      />
    );
    expect(screen.queryByText('Included With Lifetime VIP')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Verify Pending VIP Monthly Purchase' })
    ).toBeEnabled();
  });

  it('verifies a historical exact replay with the same protected request', async () => {
    const scope = marketplacePurchaseScope(USER_A, 'vip-diamonds', 'monthly');
    const pending = readOrCreateMarketplacePurchaseIntent(scope, payloadKey);
    const onWalletChanged = vi.fn();
    mocks.storeFetch.mockResolvedValueOnce(
      receipt(USER_A, pending.requestId, {
        idempotent: true,
        duplicate: true,
        expiresAt: '2020-01-01T00:00:00Z',
      })
    );
    renderMembership({ onWalletChanged });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Verify Pending VIP Monthly Purchase' })
    );

    await waitFor(() =>
      expect(mocks.storeFetch).toHaveBeenCalledWith(
        '/api/store/purchase-vip-with-diamonds',
        expect.objectContaining({
          body: {
            plan: 'monthly',
            offerConfirmation: vipDiamondOfferConfirmation(USER_A, monthlyPlan),
            idempotencyKey: pending.requestId,
          },
          idempotencyKey: pending.requestId,
          expectedUserId: USER_A,
          signal: expect.any(AbortSignal),
        })
      )
    );
    expect(readMarketplacePurchaseIntent(scope, payloadKey)).toBeNull();
    expect(mocks.toast.success).toHaveBeenCalledWith('Previous VIP Purchase Verified');
    expect(onWalletChanged).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith('BALANCE_UPDATED', { source: 'vip_purchase' });
  });

  it('does not create or submit an old-account request after confirmation resolves', async () => {
    let resolveConfirmation!: (confirmed: boolean) => void;
    mocks.confirmDialog.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        })
    );
    const refreshCatalogForPurchase = vi.fn(async () => catalog);
    const scopeA = marketplacePurchaseScope(USER_A, 'vip-diamonds', 'monthly');
    const view = renderMembership({ refreshCatalogForPurchase });

    fireEvent.click(screen.getByRole('button', { name: 'Pay 1,999 Diamonds For VIP Monthly' }));
    await waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalledTimes(1));

    view.rerender(
      <MembershipTab
        clubId="club-1"
        userId={USER_B}
        wallet={wallet()}
        plans={[monthlyPlan]}
        catalogVerified
        refreshCatalogForPurchase={refreshCatalogForPurchase}
        onWalletChanged={vi.fn()}
      />
    );
    await act(async () => {
      resolveConfirmation(true);
    });

    expect(mocks.storeFetch).not.toHaveBeenCalled();
    expect(readMarketplacePurchaseIntent(scopeA, payloadKey)).toBeNull();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('retains a resumed request after an exact remote refusal', async () => {
    const scope = marketplacePurchaseScope(USER_A, 'vip-diamonds', 'monthly');
    const pending = readOrCreateMarketplacePurchaseIntent(scope, payloadKey);
    mocks.storeFetch.mockRejectedValueOnce(
      Object.assign(new Error('Insufficient Diamonds'), {
        responseReceived: true,
        responsePath: '/api/store/purchase-vip-with-diamonds',
        status: 400,
        data: {
          success: false,
          accountId: USER_A,
          requestId: pending.requestId,
          code: 'INSUFFICIENT_DIAMONDS',
        },
      })
    );
    renderMembership();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Verify Pending VIP Monthly Purchase' })
    );

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Insufficient Diamonds'));
    expect(readMarketplacePurchaseIntent(scope, payloadKey)?.requestId).toBe(pending.requestId);
  });

  it('retires a newly created request after an exact remote precommit refusal', async () => {
    const scope = marketplacePurchaseScope(USER_A, 'vip-diamonds', 'monthly');
    let refusedRequestId = '';
    mocks.storeFetch.mockImplementationOnce(async (_path, options) => {
      refusedRequestId = options.idempotencyKey;
      throw Object.assign(new Error('Insufficient Diamonds'), {
        responseReceived: true,
        responsePath: '/api/store/purchase-vip-with-diamonds',
        status: 400,
        data: {
          success: false,
          accountId: USER_A,
          requestId: refusedRequestId,
          code: 'INSUFFICIENT_DIAMONDS',
        },
      });
    });
    renderMembership();

    fireEvent.click(screen.getByRole('button', { name: 'Pay 1,999 Diamonds For VIP Monthly' }));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Insufficient Diamonds'));
    expect(refusedRequestId).not.toBe('');
    expect(readMarketplacePurchaseIntent(scope, payloadKey)).toBeNull();
  });

  it('retains a resumed request after a local-only precommit refusal', async () => {
    const scope = marketplacePurchaseScope(USER_A, 'vip-diamonds', 'monthly');
    const pending = readOrCreateMarketplacePurchaseIntent(scope, payloadKey);
    mocks.storeFetch.mockRejectedValueOnce(
      Object.assign(new Error('Local Terms Refused'), { checkoutPrecommitRefusal: true })
    );
    renderMembership();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Verify Pending VIP Monthly Purchase' })
    );

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Local Terms Refused'));
    expect(readMarketplacePurchaseIntent(scope, payloadKey)?.requestId).toBe(pending.requestId);
  });

  it('preserves a replacement request and warns when success retirement loses its CAS', async () => {
    const scope = marketplacePurchaseScope(USER_A, 'vip-diamonds', 'monthly');
    const pending = readOrCreateMarketplacePurchaseIntent(scope, payloadKey);
    let replacementRequestId = '';
    mocks.storeFetch.mockImplementationOnce(async () => {
      expect(retireMarketplacePurchaseIntent(scope, pending.requestId)).toBe(true);
      replacementRequestId = readOrCreateMarketplacePurchaseIntent(scope, payloadKey).requestId;
      return receipt(USER_A, pending.requestId);
    });
    renderMembership();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Verify Pending VIP Monthly Purchase' })
    );

    await waitFor(() =>
      expect(mocks.toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('Secure Purchase Recovery Could Not Be Cleared')
      )
    );
    expect(readMarketplacePurchaseIntent(scope, payloadKey)?.requestId).toBe(replacementRequestId);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});
