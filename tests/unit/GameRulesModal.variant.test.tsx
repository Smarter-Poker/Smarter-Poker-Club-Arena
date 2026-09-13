import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GameRulesModal } from '@/components/table/GameRulesModal';

vi.mock('@/components/table/CardImage', () => ({ CardImage: () => <span /> }));
afterEach(cleanup);

function open(variant: string, isCashTable = false) {
  return render(
    <GameRulesModal
      isOpen
      onClose={() => {}}
      variant={variant}
      stakes="1/2"
      minBuyIn={40}
      maxBuyIn={200}
      isCashTable={isCashTable}
    />
  );
}

describe('the rules shown for the live engine variant codes', () => {
  it.each([
    ['PLO4', 4],
    ['PLO5', 5],
    ['PLO6', 6],
    ['PLO8', 4],
    ['FLO8', 4],
  ] as const)('%s deals %i cards and requires exactly two plus three', (variant, count) => {
    const { container } = open(variant);
    expect(container.textContent).toContain(`Each Player Receives ${count} Face Down`);
    expect(container.textContent).toContain('Exactly Two Of Their Hole Cards');
    expect(container.textContent).toContain('Exactly Three Community Cards');
  });

  it.each(['PLO8', 'FLO8'])('%s explains the low qualifier and indivisible chip', (variant) => {
    const { container } = open(variant);
    expect(container.textContent).toMatch(/Five Different Ranks, All Eight Or Lower/);
    expect(container.textContent).toMatch(/An Indivisible Chip Goes To The High Half/);
  });

  it.each(['NLH', 'FLH'])('%s explains Holdem selection', (variant) => {
    const { container } = open(variant);
    expect(container.textContent).toContain('Two Hole Cards');
    expect(container.textContent).toMatch(/Any Combination Of Their Hole Cards/);
  });

  it('PINEAPPLE names the actual discard timing', () => {
    const { container } = open('PINEAPPLE');
    expect(container.textContent).toContain('Three Hole Cards');
    expect(container.textContent).toMatch(/After Flop Betting And Before The Turn/);
    expect(container.textContent).toMatch(/Before Any Further Board Cards/);
    expect(container.textContent).not.toContain('Lazy');
  });

  it('SHORT_DECK uses the short deck rules and ranking order', () => {
    const { container } = open('SHORT_DECK');
    expect(container.textContent).toContain('36-Card Deck');
    expect(container.textContent).toContain('A-6-7-8-9');
    fireEvent.click(screen.getByRole('button', { name: 'Hand Ranking' }));
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings.indexOf('Flush')).toBeLessThan(headings.indexOf('Full House'));
  });

  it.each([
    ['NLH', 'No Limit'],
    ['PINEAPPLE', 'No Limit'],
    ['SHORT_DECK', 'No Limit'],
    ['PLO4', 'Pot Limit'],
    ['PLO5', 'Pot Limit'],
    ['PLO6', 'Pot Limit'],
    ['PLO8', 'Pot Limit'],
    ['FLH', 'Fixed Limit'],
    ['FLO8', 'Fixed Limit'],
  ])('%s describes %s betting', (variant, structure) => {
    const { container } = open(variant);
    fireEvent.click(screen.getByRole('button', { name: 'Betting Limits' }));
    expect(container.textContent).toContain(`In ${structure} Games`);
    if (structure === 'Fixed Limit') {
      expect(container.textContent).toContain('One Bet And Three Raises');
      expect(container.textContent).toContain('Below Half A Full Bet');
      expect(container.textContent).not.toContain('No Maximum Bet Limit');
    }
    if (structure === 'Pot Limit') {
      expect(container.textContent).toContain('Even When A Blind Is All-In For Less');
      expect(container.textContent).toMatch(/After The Flop, Only Chips Actually In The Pot Count/);
    }
  });

  it('publishes cash button and entry rules only for cash tables', () => {
    const { container, rerender } = open('NLH', true);
    expect(container.textContent).toContain('Cash Button And Blinds');
    expect(container.textContent).toContain('Acts First Before The Flop');
    expect(container.textContent).toContain('Dead Small Blind And A Live Big Blind');
    rerender(
      <GameRulesModal
        isOpen
        onClose={() => {}}
        variant="NLH"
        stakes="1/2"
        minBuyIn={40}
        maxBuyIn={200}
      />
    );
    expect(container.textContent).not.toContain('Cash Button And Blinds');
  });
});
