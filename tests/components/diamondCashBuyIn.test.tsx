import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/SoundService', () => ({
  haptic: vi.fn(),
  soundService: { playBuyInConfirm: vi.fn(), playButtonClick: vi.fn() },
}));
import BuyInModal from '../../src/components/table/BuyInModal';
const props = {
  isOpen: true,
  onClose: () => {},
  minBuyIn: 20,
  maxBuyIn: 99,
  accountBalance: 200,
  bigBlind: 2,
};
describe('Shared cash buy-in asset units', () => {
  it('submits whole Diamonds from percentage amounts without auto rebuy', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    render(<BuyInModal {...props} currency="diamonds" onConfirm={confirm} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '46.07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy In With Diamonds' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(46, false));
    // On the console the amount's stage label names the unit (the generic
    // sheet printed "( Available Diamonds:" beside the balance instead).
    expect(screen.getByText('Diamonds')).toBeTruthy();
  });
  it('does not round and replay an invalid fractional Diamond recovery intent', () => {
    render(
      <BuyInModal
        {...props}
        currency="diamonds"
        recovery={{ amount: 30.5, seat: 1 }}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Retry Original Buy-In' })).toBeDisabled();
  });
  it('preserves exact cent-valued chip purchases', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    render(<BuyInModal {...props} onConfirm={confirm} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '46.07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy Chips' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(46.07, false));
  });
});

describe('A return stack is not capped at the ordinary table maximum', () => {
  for (const currency of ['', 'diamonds']) {
    it(`requires the full return amount for ${currency || 'chips'}`, async () => {
      const confirm = vi.fn().mockResolvedValue(true);
      render(
        <BuyInModal
          {...props}
          currency={currency}
          cashoutRestriction={650}
          accountBalance={1000}
          onConfirm={confirm}
        />
      );
      const slider = screen.getByRole('slider');
      expect(slider).toHaveAttribute('min', '650');
      fireEvent.click(
        screen.getByRole('button', { name: currency ? 'Buy In With Diamonds' : 'Buy Chips' })
      );
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(650, false));
    });
  }
  it('keeps the buy-in disabled when the wallet cannot cover the full return', () => {
    render(
      <BuyInModal {...props} cashoutRestriction={650} accountBalance={600} onConfirm={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Insufficient Balance' })).toBeDisabled();
  });
});
