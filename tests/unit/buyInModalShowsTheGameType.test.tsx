/**
 * The buy-in names the game once more (Dan 2026-10-16): "BEFORE YOU JOIN A
 * TABLE, IT SHOULD DISPLAY THE GAME TYPE ONE MORE TIME SOME WHERE ABOVE OR
 * BELOW THE 'BUY IN SELECTION'". The long name prints above the amount; a
 * table whose variant is unknown prints nothing rather than a guess.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import BuyInModal from '../../src/components/table/BuyInModal';
import { gameTypeLongName } from '../../src/utils/handFormat';

const base = {
  isOpen: true,
  onClose: () => {},
  onConfirm: async () => {},
  tableName: 'NLH 0.25/0.50 Action',
  minBuyIn: 40,
  maxBuyIn: 200,
  bigBlind: 2,
  accountBalance: 500,
};

describe('the buy-in names the game being bought into', () => {
  it('prints the long game name above the amount', () => {
    render(<BuyInModal {...base} gameType="nlh" />);
    const line = screen.getByTestId('buy-in-game-type');
    expect(line.textContent).toBe("No Limit Hold'em");
    const block = line.closest('.buy-in-modal__current-amount');
    expect(block?.firstElementChild).toBe(line);
  });

  it('names Omaha and the other variants the way the lobby does', () => {
    expect(gameTypeLongName('PLO5')).toBe('Pot Limit Omaha 5');
    expect(gameTypeLongName('plo8')).toBe('Pot Limit Omaha Hi-Lo');
    expect(gameTypeLongName('short_deck')).toBe('Short Deck');
    expect(gameTypeLongName('pineapple')).toBe('Crazy Pineapple');
  });

  it('prints nothing when the variant is not known', () => {
    render(<BuyInModal {...base} gameType="" />);
    expect(screen.queryByTestId('buy-in-game-type')).toBeNull();
  });
});
