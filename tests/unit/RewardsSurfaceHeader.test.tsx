import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RewardsSurfaceHeader from '../../src/components/rewards/RewardsSurfaceHeader';
afterEach(cleanup);
describe('Rewards introductions do not add a second decorative console', () => {
  it('keeps live summary copy and controls without a frame or crest', () => {
    const { container } = render(
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Wallet"
        title="Wallet"
        description="Your Live Balances"
        metrics={[{ label: 'Diamonds', value: '1,234' }]}
        status="WALLET // SYNCING"
        actions={<button>Refresh</button>}
      />
    );
    expect(screen.getByRole('heading', { name: 'Wallet' })).toBeTruthy();
    expect(screen.getByText('SYNCING')).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(container.querySelector('.sc')).toBeNull();
    expect(container.querySelector('.sc__head')).toBeNull();
  });
  it('preserves the single content-bearing console and both live actions', () => {
    const { container } = render(
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Promotions"
        title="Promotions"
        description="Active Offers"
        plates={{ secondary: { label: 'Invite Friends' }, primary: { label: 'Daily Bonus' } }}
      >
        <p>Offer Details</p>
      </RewardsSurfaceHeader>
    );
    expect(container.querySelectorAll('.sc')).toHaveLength(1);
    expect(screen.getByText('Offer Details')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Invite Friends' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Daily Bonus' })).toBeTruthy();
  });
});

describe('Play Records without generic page frames', () => {
  it('renders a normal heading, live metrics and actions when the page opts out', () => {
    const { container } = render(
      <RewardsSurfaceHeader
        unframed
        eyebrow="Play & Review / Hands"
        title="Hand Archive"
        description="Your Recorded Hands"
        metrics={[{ label: 'Loaded', value: 12 }]}
        actions={<button>Refresh Hands</button>}
      />
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Hand Archive' })).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh Hands' })).toBeTruthy();
    expect(container.querySelector('.sc')).toBeNull();
  });
});
