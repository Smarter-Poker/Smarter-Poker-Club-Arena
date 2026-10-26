import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import LightningCashEntryCard from '../../src/components/lightning/LightningCashEntryCard';
import { lightningStakeText } from '../../src/lightning/lightningStakeText';
import { parseLightningClusterMeta } from '../../src/lightning/lightningSession';
afterEach(cleanup);
describe('the approved Lightning cash-game card', () => {
  it('uses the exact cash frame, compact details and the existing two actions', () => {
    const join = vi.fn(),
      back = vi.fn();
    const { container } = render(
      <LightningCashEntryCard
        title="PLO5 1.00/2.00 Lightning Games"
        variant="PLO5"
        stakes="1.00/2.00"
        players={11}
        buyIn="200 - 400"
        status="Running"
        actions={{
          primaryLabel: 'Join Lightning',
          secondaryLabel: 'Return To Lobby',
          onPrimary: join,
          onSecondary: back,
        }}
      />
    );
    expect(container.querySelectorAll('.agc-nlh-premium')).toHaveLength(1);
    expect(container.querySelector('.agc-nlh-premium__chassis')?.getAttribute('src')).toContain(
      '/nlh/spade-nlh-premium-v1/chassis.png'
    );
    expect(container.querySelector('[data-zone="gameType"]')?.textContent).toBe('PLO5');
    expect(container.querySelector('[data-zone="stakes"]')?.textContent).toBe('1/2');
    expect(container.querySelector('[data-zone="players"]')?.textContent).toBe('11');
    expect(container.querySelector('[data-zone="buyIn"]')?.textContent).toBe('200 - 400');
    expect(container.textContent).not.toMatch(
      /Buy In Once|Last Played|Your Lightning Tables|1\.00/
    );
    fireEvent.click(screen.getByRole('button', { name: 'Join Lightning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Return To Lobby' }));
    expect(join).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
    const page = readFileSync('src/pages/LightningEntryPage.tsx', 'utf8');
    expect(page).toContain('<LightningCashEntryCard');
    expect(page).not.toContain('<LightningMySessions');
    expect(page).not.toContain('<LightningPoolBadge');
  });
  it('keeps closed joins disabled', () => {
    const join = vi.fn();
    render(
      <LightningCashEntryCard
        title="NLH 1/2 Lightning"
        variant="NLH"
        stakes="1/2"
        status="Closed"
        primaryTestId="closed-join"
        actions={{ primaryLabel: 'Join Lightning', primaryDisabled: true, onPrimary: join }}
      />
    );
    fireEvent.click(screen.getByTestId('closed-join'));
    expect(join).not.toHaveBeenCalled();
    expect(screen.getByTestId('closed-join').hasAttribute('disabled')).toBe(true);
  });
  it.each([
    ['1.00 / 2.00', '1/2'],
    ['0.25/0.50', '0.25/0.50'],
  ])('formats stakes %s accurately', (input, expected) =>
    expect(lightningStakeText(input)).toBe(expected)
  );
  it('reads the configured buy-in band without inventing defaults', () => {
    const base = {
      id: 'cluster',
      bb: 2,
      ruleset_snapshot: { min_buyin_bb: 100, max_buyin_bb: 200 },
    };
    expect(parseLightningClusterMeta(base)).toMatchObject({ minBuyIn: 200, maxBuyIn: 400 });
    expect(parseLightningClusterMeta({ id: 'cluster', bb: 2 })).toMatchObject({
      minBuyIn: null,
      maxBuyIn: null,
    });
  });
});
