import React, { useEffect } from 'react';
import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ account: 'first', mounted: vi.fn(), retired: vi.fn() }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: (state: unknown) => unknown) => select({ user: { id: mocks.account } }),
}));
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../src/components/daily-bonus/DailyBonusSheet', () => ({
  default: function Sheet() {
    useEffect(() => {
      const account = mocks.account;
      mocks.mounted(account);
      return () => mocks.retired(account);
    }, []);
    return null;
  },
}));
import DailyBonusPage from '../../src/pages/DailyBonusPage';
it('retires account-owned shown-day, spin-club and animation state on an account change', () => {
  const page = render(<DailyBonusPage />);
  expect(mocks.mounted).toHaveBeenCalledWith('first');
  mocks.account = 'second';
  page.rerender(<DailyBonusPage />);
  expect(mocks.retired).toHaveBeenCalledWith('first');
  expect(mocks.mounted).toHaveBeenCalledWith('second');
});
