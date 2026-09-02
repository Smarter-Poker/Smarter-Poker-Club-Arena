import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Rabbit Hunt human decision safety', () => {
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
