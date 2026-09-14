import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const monthlyLimits = {
  rabbitHunts: { used: 0, limit: 0 },
  timeBankSeconds: { used: 0, limit: 0 },
  emojis: { used: 0, limit: 0 },
  tags: { used: 0, limit: 0 },
  throwables: { used: 0, limit: 0 },
};

const mocks = vi.hoisted(() => {
  const success = vi.fn();
  const error = vi.fn();
  return {
    currentUser: { id: 'account-a' } as { id: string } | null,
    checkVIPStatus: vi.fn(),
    purchaseFeature: vi.fn(),
    emit: vi.fn(),
    success,
    error,
    toast: { success, error },
  };
});

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.currentUser }),
}));

vi.mock('../../src/services/VIPService', () => ({
  VIP_MONTHLY_ALLOWANCES: {
    rabbitHunts: 100,
    timeBankSeconds: 120,
    emojis: 1200,
    tags: 1000,
    throwables: 500,
  },
  FEATURE_PRICING: {
    rabbit_hunt: { cost: 5, usageType: 'per_use', description: 'Reveal Undealt Cards' },
  },
  vipService: {
    checkVIPStatus: mocks.checkVIPStatus,
    purchaseFeature: mocks.purchaseFeature,
  },
  normalizeVIPPurchaseError: (value: unknown) =>
    String(value ?? '')
      .toLowerCase()
      .includes('insufficient')
      ? 'Insufficient Diamonds'
      : 'Purchase Failed',
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      let requestedUserId = '';
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (_column: string, value: string) => {
        requestedUserId = value;
        return builder;
      };
      builder.order = () => builder;
      builder.maybeSingle = () =>
        Promise.resolve({
          data:
            table === 'profiles'
              ? { diamonds: requestedUserId === 'account-a' ? 100 : 200 }
              : { current_points: 0, lifetime_points: 0 },
          error: null,
        });
      builder.limit = () => Promise.resolve({ data: [], error: null });
      return builder;
    },
    rpc: vi.fn(),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: mocks.emit,
    subscribeDebounced: vi.fn(() => () => {}),
  },
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('../../src/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: vi.fn(),
}));

vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: () => <div>VIP Header</div>,
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => <div>Loading</div> }));
vi.mock('../../src/components/vip/VIPCardsModal', () => ({ VIPCardsModal: () => null }));
vi.mock('../../src/components/vip/VIPPerksGrid', () => ({ VIPPerksGrid: () => null }));
vi.mock('../../src/components/vip/DiamondTopUpModal', () => ({ DiamondTopUpModal: () => null }));
vi.mock('../../src/components/vip/VIPMembershipPlate', () => ({
  VIPMembershipPlate: () => null,
}));
vi.mock('../../src/components/vip/RewardsMarketplace', () => ({
  RewardsMarketplace: () => null,
}));
vi.mock('../../src/components/vip/VIPActivityHistory', () => ({
  VIPActivityHistory: () => null,
}));
vi.mock('../../src/components/wallet/DiamondWalletModal', () => ({ default: () => null }));

import VIPPage from '../../src/pages/VIPPage';

afterEach(() => {
  cleanup();
  mocks.currentUser = { id: 'account-a' };
  vi.clearAllMocks();
});

describe('VIP Page Account Isolation', () => {
  it('never paints lowercase database refusal copy', async () => {
    mocks.checkVIPStatus.mockResolvedValue({
      isVIP: false,
      status: 'none',
      expiresAt: null,
      monthlyLimits,
    });
    mocks.purchaseFeature.mockResolvedValue({
      success: false,
      charged: 0,
      error: 'Insufficient diamonds',
    });

    render(<VIPPage />);
    await waitFor(() => expect(screen.getByText('100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Insufficient Diamonds'));
    expect(mocks.error).not.toHaveBeenCalledWith('Insufficient diamonds');
  });

  it('ignores an old purchase while preserving the replacement account request', async () => {
    let resolveAccountA!: (value: unknown) => void;
    let resolveAccountB!: (value: unknown) => void;
    const accountARequest = new Promise((resolve) => {
      resolveAccountA = resolve;
    });
    const accountBRequest = new Promise((resolve) => {
      resolveAccountB = resolve;
    });
    mocks.checkVIPStatus.mockResolvedValue({
      isVIP: false,
      status: 'none',
      expiresAt: null,
      monthlyLimits,
    });
    mocks.purchaseFeature.mockReturnValueOnce(accountARequest).mockReturnValueOnce(accountBRequest);

    const { rerender } = render(<VIPPage />);
    await waitFor(() => expect(screen.getByText('100')).toBeTruthy());
    expect(screen.getByText('Rabbit Hunt')).toBeTruthy();
    expect(screen.queryByText('rabbit hunt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(mocks.purchaseFeature).toHaveBeenCalledWith('account-a', 'rabbit_hunt');

    mocks.currentUser = { id: 'account-b' };
    rerender(<VIPPage />);
    await waitFor(() => expect(screen.getByText('200')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(mocks.purchaseFeature).toHaveBeenLastCalledWith('account-b', 'rabbit_hunt');

    await act(async () => {
      resolveAccountA({ success: true, charged: 5 });
      await accountARequest;
    });

    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '...' })).toBeDisabled();

    await act(async () => {
      resolveAccountB({ success: true, charged: 5 });
      await accountBRequest;
    });

    await waitFor(() => expect(screen.getByText('195')).toBeTruthy());
    expect(mocks.success).toHaveBeenCalledWith('Purchased Rabbit Hunt For 5 Diamonds');
    expect(mocks.emit).toHaveBeenCalledWith('DIAMOND_BALANCE_CHANGED', {
      newBalance: 195,
      delta: -5,
      source: 'vip_feature_purchase',
    });
  });
});
