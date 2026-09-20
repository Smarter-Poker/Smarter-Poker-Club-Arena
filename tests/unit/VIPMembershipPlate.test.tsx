import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VIPMembershipPlate } from '../../src/components/vip/VIPMembershipPlate';

const limits = {
  rabbitHunts: { used: 10, limit: 100 },
  timeBankSeconds: { used: 20, limit: 120 },
  emojis: { used: 200, limit: 1200 },
  tags: { used: 100, limit: 1000 },
  throwables: { used: 50, limit: 500 },
};

const points = { current: 100, lifetime: 200, monthly: 30, activeStreak: 4 };

afterEach(cleanup);

describe('VIPMembershipPlate Lifetime contract', () => {
  it('keeps the ordinary VIP monthly Rabbit Hunt and Throwable caps', () => {
    const { container } = render(
      <VIPMembershipPlate status="vip" expiresAt={null} limits={limits} points={points} />
    );

    expect(container.textContent).toContain('90 Of 100 Left');
    expect(container.textContent).toContain('450 Of 500 Left');
    expect(container.textContent).toContain('Included Each Month');
    expect(container.textContent).not.toContain('Unlimited With Lifetime VIP');
  });

  it('replaces the Lifetime gameplay meters with unlimited access', () => {
    const { container, getByText, getAllByText } = render(
      <VIPMembershipPlate status="lifetime" expiresAt={null} limits={limits} points={points} />
    );

    expect(getAllByText('Unlimited With Lifetime VIP')).toHaveLength(3);
    expect(getAllByText('All Digital Options Included')).toHaveLength(4);
    expect(container.textContent).not.toContain('90 Of 100 Left');
    expect(container.textContent).not.toContain('100s Of 120s Left');
    expect(container.textContent).not.toContain('450 Of 500 Left');
    expect(container.textContent).not.toContain('1,000 Of 1,200 Left');
    expect(container.textContent).not.toContain('900 Of 1,000 Left');
    expect(getByText('Digital Emoji Packs')).toBeTruthy();
    expect(getByText('Player Tags')).toBeTruthy();
    expect(getByText('Standard 20-Second Time Bank Activations')).toBeTruthy();
    expect(getByText('Cataloged Table Skins And Backgrounds')).toBeTruthy();
    expect(getByText('Cataloged Card Backs And Dealer Buttons')).toBeTruthy();
    expect(getByText('VIP Avatars, Frames, And Auras')).toBeTruthy();
    expect(container.textContent).not.toContain('Included Each Month');
  });
});
