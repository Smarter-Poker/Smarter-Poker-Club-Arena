import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import BonusSetup from '../../src/components/games/BonusSetup';
import MinesGrid from '../../src/components/games/MinesGrid';
afterEach(cleanup);
describe('visible Plinko allocation controls', () => {
  it('changes 100 single-diamond drops into 25 four-diamond drops without starting a game', () => {
    function Entry() {
      const [budget, setBudget] = useState({ base: 100, doubled: false, denomination: 1 });
      return (
        <BonusSetup
          budget={budget}
          onChange={setBudget}
          diamonds={1000}
          disabled={false}
          plinko
          clubId="club"
        />
      );
    }
    render(
      <MemoryRouter>
        <Entry />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: '4 Diamonds Per Drop, 25 Drops' }));
    expect(screen.getByText('25 Drops × 4 Diamonds = 100 Diamonds')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('50 Drops × 4 Diamonds = 200 Diamonds')).toBeTruthy();
  });
  it('locks the actual choices during admission and animation', () => {
    const change = vi.fn();
    render(
      <MemoryRouter>
        <BonusSetup
          budget={{ base: 100, doubled: false, denomination: 1 }}
          onChange={change}
          diamonds={1000}
          disabled
          plinko
          clubId="club"
        />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: '4 Diamonds Per Drop, 25 Drops' }));
    expect(change).not.toHaveBeenCalled();
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
