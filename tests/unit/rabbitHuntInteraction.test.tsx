import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('../../src/hooks/useButtonImage', () => ({
  useButtonImage: () => '/rabbit.webp',
}));

vi.mock('../../src/services/VIPService', () => ({
  FEATURE_PRICING: { rabbit_hunt: { cost: 5 } },
  vipService: {
    checkVIPStatus: vi.fn().mockResolvedValue({
      isVIP: false,
      monthlyLimits: { rabbitHunts: { used: 0, limit: 0 } },
    }),
  },
}));

const toast = {
  error: vi.fn(),
  info: vi.fn(),
};

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => toast,
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import RabbitHunt from '../../src/components/table/RabbitHunt';
import { vipService } from '../../src/services/VIPService';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Rabbit Hunt human decision safety', () => {
  it('masks a previous account while the replacement entitlement is loading', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    vi.mocked(vipService.checkVIPStatus)
      .mockReturnValueOnce(first as any)
      .mockReturnValueOnce(second as any);

    const { getByRole, queryByText, rerender } = render(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId="account-a"
        onReveal={vi.fn()}
      />
    );
    rerender(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId="account-b"
        onReveal={vi.fn()}
      />
    );

    expect(getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' })).toBeTruthy();
    expect(queryByText('Unlimited')).toBeNull();

    await act(async () => {
      resolveFirst({
        isVIP: true,
        status: 'lifetime',
        monthlyLimits: { rabbitHunts: { used: 100, limit: 100 } },
      });
      await first;
    });
    expect(getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' })).toBeTruthy();
    expect(queryByText('Unlimited')).toBeNull();

    await act(async () => {
      resolveSecond({
        isVIP: true,
        status: 'vip',
        monthlyLimits: { rabbitHunts: { used: 98, limit: 100 } },
      });
      await second;
    });
    await waitFor(() =>
      expect(getByRole('button', { name: 'Rabbit Hunt, 2 Free This Month' })).toBeTruthy()
    );
  });

  it('announces and paints Unlimited only for exact Lifetime VIP', async () => {
    vi.mocked(vipService.checkVIPStatus).mockResolvedValueOnce({
      isVIP: true,
      status: 'lifetime',
      expiresAt: null,
      monthlyLimits: { rabbitHunts: { used: 100, limit: 100 } },
    } as any);
    const { getByRole, getByText, queryByText } = render(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId="11111111-2222-4333-8444-555555555555"
        onReveal={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(getByRole('button', { name: 'Rabbit Hunt, Unlimited With Lifetime VIP' })).toBeTruthy()
    );
    expect(getByText('Unlimited')).toBeTruthy();
    expect(queryByText('100')).toBeNull();
  });

  it('keeps the ordinary VIP monthly countdown', async () => {
    vi.mocked(vipService.checkVIPStatus).mockResolvedValueOnce({
      isVIP: true,
      status: 'vip',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      monthlyLimits: { rabbitHunts: { used: 99, limit: 100 } },
    } as any);
    const { getByRole, getByText, queryByText } = render(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId="11111111-2222-4333-8444-555555555555"
        onReveal={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(getByRole('button', { name: 'Rabbit Hunt, 1 Free This Month' })).toBeTruthy()
    );
    expect(getByText('1')).toBeTruthy();
    expect(getByText('Free')).toBeTruthy();
    expect(queryByText('Unlimited')).toBeNull();
  });

  it('announces the paid price and single-flights a same-frame double activation', async () => {
    let release!: (result: {
      success: boolean;
      cards: { rank: string; suit: 'c' }[];
      diamondsSpent: number;
    }) => void;
    const pending = new Promise<{
      success: boolean;
      cards: { rank: string; suit: 'c' }[];
      diamondsSpent: number;
    }>((resolve) => {
      release = resolve;
    });
    const onReveal = vi.fn(() => pending);
    const { getByRole, queryByRole } = render(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId="11111111-2222-4333-8444-555555555555"
        onReveal={onReveal}
      />
    );
    const button = getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' }) as HTMLButtonElement;

    fireEvent.click(button);
    fireEvent.click(button);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    release({ success: true, cards: [{ rank: 'A', suit: 'c' }], diamondsSpent: 5 });
    await waitFor(() => expect(queryByRole('button')).toBeNull());
    expect(toast.info).toHaveBeenCalledWith('5 Diamonds Charged');
  });

  it('does not call the paid endpoint without an authenticated player', () => {
    const onReveal = vi.fn();
    const { getByRole } = render(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId={null}
        onReveal={onReveal}
      />
    );

    fireEvent.click(getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' }));
    expect(onReveal).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Please Log In To Use Rabbit Hunt');
  });
});
