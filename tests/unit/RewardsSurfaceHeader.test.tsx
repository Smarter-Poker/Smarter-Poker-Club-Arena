import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RewardsSurfaceHeader from '../../src/components/rewards/RewardsSurfaceHeader';
afterEach(cleanup);

/*
 * Dan, 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL
 * DESCRIPTIONS... ADD A ? MARK ICON INSTEAD IN THE UPPER RIGHT CORNER".
 * The title is for assistive technology only, the description is what the
 * "?" explains, and the live figures and actions stay on the page.
 */
describe('Rewards pages print a page bar, not an introduction', () => {
  it('keeps live figures and actions, hides the title and moves the description behind the "?"', () => {
    const { container } = render(
      <RewardsSurfaceHeader
        title="Wallet"
        description="Your Live Balances"
        metrics={[{ label: 'Diamonds', value: '1,234' }]}
        status="WALLET // SYNCING"
        actions={<button>Refresh</button>}
      />
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Wallet' });
    expect(heading.className).toBe('sr-only');
    expect(screen.getByRole('status').textContent).toBe('SYNCING');
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('attention');
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.queryByText('Your Live Balances')).toBeNull();
    expect(container.querySelector('.sc')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Page Help' }));
    expect(screen.getByRole('dialog').textContent).toContain('Your Live Balances');
    expect(screen.getByRole('button', { name: 'Start Tutorial' })).toBeTruthy();
  });

  it('says nothing when a page is simply live', () => {
    render(<RewardsSurfaceHeader title="Rakeback" description="Weekly" status="ENGINE // LIVE" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('prints the two doors as lit words when no console carries the page', () => {
    const { container } = render(
      <RewardsSurfaceHeader
        title="Club Marketplace"
        description="Buy Things"
        plates={{ secondary: { label: 'Owned Items' }, primary: { label: 'Buy Diamonds' } }}
      />
    );
    expect(container.querySelector('.sc')).toBeNull();
    expect(screen.getByRole('button', { name: 'Owned Items' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Buy Diamonds' })).toBeTruthy();
  });

  it('keeps the one console a page prints itself on, with no eyebrow or description on it', () => {
    const { container } = render(
      <RewardsSurfaceHeader
        title="Promotions"
        description="Active Offers"
        plates={{ secondary: { label: 'Invite Friends' }, primary: { label: 'Daily Bonus' } }}
      >
        <p>Offer Details</p>
      </RewardsSurfaceHeader>
    );
    expect(container.querySelectorAll('.sc')).toHaveLength(1);
    expect(container.querySelector('.sc__eyebrow')).toBeNull();
    expect(screen.queryByText('Active Offers')).toBeNull();
    expect(screen.getByText('Offer Details')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Invite Friends' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Daily Bonus' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page Help' })).toBeTruthy();
  });
});
