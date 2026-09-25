import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import BonusSetup from '../../src/components/games/BonusSetup';
import MinesGrid from '../../src/components/games/MinesGrid';
import { plinkoAllocations, plinkoBudget } from '../../src/utils/bonusGameBudget';
afterEach(cleanup);
/**
 * THE PLAYER CHOOSES THE DROP VALUE (Dan 2026-09-21, R6: "On Plinko the player
 * must choose how many diamonds to drop and the value of each drop. Today it is
 * just defaulted at 10 diamonds"). This moves the 2026-09-19 pin that the value
 * was derived and nothing was offered: the selector is back, it offers only the
 * values that divide the stake into 1 to 100 drops, it shows the drops each
 * value makes, and it pre-selects NOTHING.
 */
describe('visible Plinko allocation controls', () => {
  it('offers every drop value that fits the entry, with nothing pressed until the player presses it', () => {
    function Entry() {
      const [budget, setBudget] = useState(() =>
        plinkoBudget({ base: 100, doubled: false, denomination: null })
      );
      return (
        <BonusSetup
          budget={budget}
          onChange={(next) => setBudget(plinkoBudget(next))}
          diamonds={1000}
          disabled={false}
          game="plinko"
          clubId="club"
        />
      );
    }
    render(
      <MemoryRouter>
        <Entry />
      </MemoryRouter>
    );
    const selector = () => screen.getByRole('group', { name: 'Diamonds Per Drop' });
    const choices = () => within(selector()).getAllByRole('button');
    expect(choices().map((b) => b.getAttribute('aria-label'))).toEqual(
      plinkoAllocations(100).map(
        (a) =>
          `${a.diamondsPerDrop} ${a.diamondsPerDrop === 1 ? 'Diamond' : 'Diamonds'} Per Drop, ${a.drops} ${a.drops === 1 ? 'Drop' : 'Drops'}`
      )
    );
    expect(choices().every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(screen.getByText('Choose Your Diamonds Per Drop To Play 100 Diamonds.')).toBeTruthy();
    expect(screen.queryByText(/Drops ×/)).toBeNull();
    // A choice: the line reads drops x value = entry, and only that button is pressed.
    fireEvent.click(screen.getByRole('button', { name: '4 Diamonds Per Drop, 25 Drops' }));
    expect(screen.getByText('25 Drops × 4 Diamonds = 100 Diamonds')).toBeTruthy();
    expect(choices().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '100 Diamonds Per Drop, 1 Drop' }));
    expect(screen.getByText('1 Drop × 100 Diamonds = 100 Diamonds')).toBeTruthy();
    // Double Down doubles the entry: 100 a drop still divides 200, so the choice
    // stays and the drops move with it.
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('2 Drops × 100 Diamonds = 200 Diamonds')).toBeTruthy();
    // Nothing offers a risk level any more.
    expect(screen.queryByRole('button', { name: /Risk/ })).toBeNull();
  });
  it('locks the entry, Double Down and the selector during admission and animation', () => {
    const change = vi.fn();
    render(
      <MemoryRouter>
        <BonusSetup
          budget={plinkoBudget({ base: 100, doubled: false, denomination: 10 })}
          onChange={change}
          diamonds={1000}
          disabled
          game="plinko"
          clubId="club"
        />
      </MemoryRouter>
    );
    const entry = screen.getByLabelText('Entry Diamonds');
    expect(entry).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByText('10 Drops × 10 Diamonds = 100 Diamonds')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '4 Diamonds Per Drop, 25 Drops' }));
    expect(change).not.toHaveBeenCalled();
  });
  it('names the Super form of the game and reads the server quote for a Super award', () => {
    render(
      <MemoryRouter>
        <BonusSetup
          budget={plinkoBudget({
            base: 200,
            doubled: false,
            denomination: 20,
            award: {
              id: '00000000-0000-0000-0000-000000000077',
              entryDiamonds: 100,
              boostMultiplier: 2,
            },
          })}
          onChange={vi.fn()}
          diamonds={1000}
          disabled
          game="plinko"
          guarantee={{
            guarantee: 'super',
            minimumPayoutChips: 10,
            mode: null,
            plinkoTable: 4,
          }}
          clubId="club"
        />
      </MemoryRouter>
    );
    expect(screen.getByText('Super Plinko Award')).toBeTruthy();
    expect(
      screen.getByText('Super Plinko Pays At Least 10.00 Chips, Even If Every Drop Lands Low.')
    ).toBeTruthy();
    expect(screen.getByText('10 Drops × 20 Diamonds = 200 Diamonds')).toBeTruthy();
  });
});
describe('every Mines tile owns its gem and its hit target', () => {
  it('preserves all 25 cells after a reveal and routes the next pick to its own cell', () => {
    const pick = vi.fn();
    const page = render(
      <MinesGrid picked={[6]} mines={null} phase="open" busy={false} onPick={pick} />
    );
    expect(screen.getAllByRole('button')).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Tile 7, Gem' }).querySelector('svg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tile 8', exact: true }));
    expect(pick).toHaveBeenCalledWith(7);
    page.rerender(
      <MinesGrid picked={[6, 7]} mines={[7, 19]} phase="lost" busy={false} onPick={pick} />
    );
    expect(screen.getAllByRole('button', { name: /Mine/ })).toHaveLength(2);
    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(
      true
    );
  });
});
