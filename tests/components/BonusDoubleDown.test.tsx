import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import BonusSetup from '../../src/components/games/BonusSetup';
import { bonusTotal, type BonusBudget } from '../../src/utils/bonusGameBudget';

afterEach(cleanup);
const initial: BonusBudget = {
  base: 200,
  doubled: false,
  denomination: 20,
  award: { id: '00000000-0000-0000-0000-000000000077', entryDiamonds: 100, boostMultiplier: 2 },
};
function Entry({ diamonds, change }: { diamonds: number; change: (budget: BonusBudget) => void }) {
  const [budget, setBudget] = useState(initial);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Selected Entry">{bonusTotal(budget)}</output>
      <output aria-label="Current Route">
        {location.pathname}
        {location.search}
      </output>
      <BonusSetup
        budget={budget}
        // The invitation is the same for every game. Crash keeps this fixture off
        // the Plinko drop-value copy, which the entry hook derives, not this dialog.
        game="crash"
        diamonds={diamonds}
        disabled={false}
        clubId="shark-club"
        // A page leaves through its own hold; this fixture has none to let go of.
        leave={navigate}
        onChange={(next) => {
          change(next);
          setBudget(next);
        }}
      />
    </>
  );
}
function showOffer(diamonds: number, change = vi.fn()) {
  render(
    <MemoryRouter>
      <Entry diamonds={diamonds} change={change} />
    </MemoryRouter>
  );
  const dialog = screen.getByRole('dialog', { name: 'Double Down Your Bonus' });
  return {
    dialog,
    change,
    reveal: () => fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!),
  };
}
describe('earned bonus Double Down invitation', () => {
  it('animates the invitation and changes only the selected extra entry after an explicit choice', () => {
    const { dialog, change, reveal } = showOffer(500);
    expect(dialog).toHaveTextContent('Add 100 Diamonds To Your 200 Diamond Bonus.');
    expect(dialog).toHaveTextContent('Extra Diamonds Are Used Only When You Start The Game.');
    expect(within(dialog).getByRole('button', { name: 'Add Diamonds' })).toBeDisabled();
    expect(change).not.toHaveBeenCalled();
    reveal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Diamonds' }));
    expect(change).toHaveBeenCalledExactlyOnceWith({ ...initial, doubled: true });
    expect(screen.getByLabelText('Selected Entry')).toHaveTextContent('300');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('lets a player keep the funded award or buy the missing diamonds without selecting a debit', () => {
    const { dialog, change, reveal } = showOffer(25);
    expect(dialog).toHaveTextContent('You Need 75 More Diamonds To Double Down.');
    reveal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep My Bonus' }));
    expect(change).toHaveBeenCalledExactlyOnceWith(initial);
    fireEvent.click(screen.getByRole('button', { name: 'Double Down Your Bonus' }));
    const reopened = screen.getByRole('dialog', { name: 'Double Down Your Bonus' });
    fireEvent.animationEnd(reopened.querySelector('[data-motion="keep"]')!);
    fireEvent.click(within(reopened).getByRole('button', { name: 'Buy More' }));
    expect(screen.getByLabelText('Current Route')).toHaveTextContent('/marketplace?tab=diamonds');
    expect(change).toHaveBeenCalledTimes(1);
  });
});
