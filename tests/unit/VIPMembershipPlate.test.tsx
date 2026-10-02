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

const points = { current: 100, lifetime: 200 };

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

/**
 * Added 2026-09-30 with the fix for the discarded `vip_points` read on VIPPage.
 * The two figures that read owns must be able to say they are UNKNOWN, and a
 * real zero must keep printing as a zero - CLAUDE.md 10.86 rule 1. Both halves
 * are asserted, because only the pair proves the two are distinguishable.
 */
describe('VIPMembershipPlate points that could not be read', () => {
  const zeroPoints = { current: 0, lifetime: 0 };
  const pointCells = (container: HTMLElement) =>
    [...container.querySelectorAll('.vmp__points div')].map((d) => d.textContent || '');

  it('prints Unavailable for Points and Lifetime when the read failed', () => {
    const { container } = render(
      <VIPMembershipPlate
        status="vip"
        expiresAt={null}
        limits={limits}
        points={zeroPoints}
        pointsState="error"
      />
    );

    const cells = pointCells(container);
    expect(cells[0]).toContain('Unavailable');
    expect(cells[1]).toContain('Unavailable');
  });

  it('prints 0 when the read succeeded and the player really has none', () => {
    const { container } = render(
      <VIPMembershipPlate
        status="vip"
        expiresAt={null}
        limits={limits}
        points={zeroPoints}
        pointsState="ready"
      />
    );

    expect(container.textContent).not.toContain('Unavailable');
    const cells = pointCells(container);
    expect(cells[0]).toContain('0');
    expect(cells[1]).toContain('0');
  });

  it('an omitted pointsState behaves as ready, so existing callers are unchanged', () => {
    const { container } = render(
      <VIPMembershipPlate status="vip" expiresAt={null} limits={limits} points={points} />
    );

    expect(container.textContent).not.toContain('Unavailable');
    const cells = pointCells(container);
    expect(cells[0]).toContain('100');
    expect(cells[1]).toContain('200');
  });
});

/**
 * 2026-09-30. "This Month" and "Active Streak" stood in this dl and were
 * hardcoded zeros: `vip_points` has only user_id, current_points,
 * lifetime_points and updated_at, and no client code ever set either field,
 * so every player was told they had earned 0 points this month and held a
 * 0 day streak. Both readouts are gone.
 *
 * The first test below would also pass on a plate that had stopped printing
 * figures altogether, so it is deliberately paired with the second: the
 * plate must still print a REAL zero for a player who genuinely has none.
 * That pairing is the whole point - removing a fabricated zero must not
 * become an excuse to stop reporting a true one.
 */
describe('VIPMembershipPlate prints no figure the platform cannot compute', () => {
  const cellsOf = (container: HTMLElement) =>
    [...container.querySelectorAll('.vmp__points div')].map((d) => d.textContent || '');

  it('offers neither a monthly points figure nor an active streak', () => {
    const { container } = render(
      <VIPMembershipPlate status="vip" expiresAt={null} limits={limits} points={points} />
    );

    const dl = container.querySelector('.vmp__points');
    expect(dl?.textContent).not.toContain('This Month');
    expect(dl?.textContent).not.toContain('Active Streak');
    // The only surviving cells are the two `vip_points` actually answers.
    expect(cellsOf(container)).toHaveLength(2);
  });

  it('still prints a genuine zero for a player who has earned none', () => {
    const { container } = render(
      <VIPMembershipPlate
        status="vip"
        expiresAt={null}
        limits={limits}
        points={{ current: 0, lifetime: 0 }}
        pointsState="ready"
      />
    );

    const cells = cellsOf(container);
    expect(cells[0]).toContain('Points');
    expect(cells[0]).toContain('0');
    expect(cells[1]).toContain('Lifetime');
    expect(cells[1]).toContain('0');
    expect(container.textContent).not.toContain('Unavailable');
  });
});
