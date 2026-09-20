import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import BonusSetup from '../../src/components/games/BonusSetup';
import MinesGrid from '../../src/components/games/MinesGrid';
import { PLINKO_DROPS, plinkoBudget } from '../../src/utils/bonusGameBudget';
afterEach(cleanup);
/**
 * THE DROP VALUE IS DERIVED, SO THERE IS NOTHING TO ALLOCATE.
 *
 * This describe used to click '4 Diamonds Per Drop, 25 Drops' and pass a
 * `plinko` boolean. Both are gone: BonusSetup takes `game`, every Plinko game
 * is exactly PLINKO_DROPS drops of a tenth of the entry, and the only figures a
 * player changes are the entry itself and Double Down. What used to be a choice
 * is now an identity, so that is what is asserted.
 */
describe('visible Plinko allocation controls', () => {
  it('derives the ten-drop line from the entry and offers no drop choice at all', () => {
    function Entry() {
      const [budget, setBudget] = useState(() =>
        plinkoBudget({ base: 100, doubled: false, denomination: 1 })
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
    expect(PLINKO_DROPS).toBe(10);
    expect(screen.getByText('10 Drops × 10 Diamonds = 100 Diamonds')).toBeTruthy();
    // Nothing offers a drop value, a drop count or a risk level any more.
    expect(screen.queryByRole('button', { name: /Per Drop/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Drops/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Risk/ })).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Buy More',
      'Earn Diamonds',
    ]);
    // Double Down doubles the entry, and the tenth moves with it. Still ten drops.
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('10 Drops × 20 Diamonds = 200 Diamonds')).toBeTruthy();
  });
  it('locks the entry and Double Down during admission and animation', () => {
    const change = vi.fn();
    render(
      <MemoryRouter>
        <BonusSetup
          budget={plinkoBudget({ base: 100, doubled: false, denomination: 1 })}
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
    expect(change).not.toHaveBeenCalled();
  });
  it('names the Super form of the game and reads the server quote for a Super award', () => {
    render(
      <MemoryRouter>
        <BonusSetup
          budget={plinkoBudget({
            base: 200,
            doubled: false,
            denomination: 1,
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
