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

afterEach(cleanup);

describe('VIPMembershipPlate Lifetime contract', () => {
  it('keeps the ordinary VIP monthly Rabbit Hunt and Throwable caps', () => {
    const { container } = render(
      <VIPMembershipPlate status="vip" expiresAt={null} limits={limits} />
    );

    expect(container.textContent).toContain('90 Of 100 Left');
    expect(container.textContent).toContain('450 Of 500 Left');
    expect(container.textContent).toContain('Included Each Month');
    expect(container.textContent).not.toContain('Unlimited With Lifetime VIP');
  });

  it('replaces the Lifetime gameplay meters with unlimited access', () => {
    const { container } = render(
      <VIPMembershipPlate status="lifetime" expiresAt={null} limits={limits} />
    );
    expect(container.textContent).toContain('Lifetime VIP');
    expect(container.textContent).toContain('Never Expires');
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(container.textContent).not.toContain('Included Each Month');
  });
});

describe('VIP membership does not advertise a points currency', () => {
  it.each(['none', 'vip', 'lifetime'] as const)(
    'keeps %s membership independent of points',
    (status) => {
      const { container } = render(
        <VIPMembershipPlate status={status} expiresAt={null} limits={limits} />
      );
      expect(container.querySelector('.vmp__points')).toBeNull();
      expect(container.textContent).not.toMatch(/Points|Lifetime Points/);
    }
  );
});
