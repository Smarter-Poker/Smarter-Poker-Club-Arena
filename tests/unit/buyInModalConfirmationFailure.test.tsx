import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BuyInModal from '../../src/components/table/BuyInModal';
import { soundService } from '../../src/services/SoundService';
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playBuyInConfirm: vi.fn() },
  haptic: { light: vi.fn() },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const base = {
  isOpen: true,
  onClose: vi.fn(),
  minBuyIn: 40,
  maxBuyIn: 200,
  bigBlind: 2,
  accountBalance: 200,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('buy-in confirmation failures', () => {
  it('a decorative sound failure cannot prevent the purchase callback', async () => {
    vi.mocked(soundService.playBuyInConfirm).mockImplementationOnce(() => {
      throw new Error('audio locked');
    });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<BuyInModal {...base} onConfirm={onConfirm} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Buy Chips'));
    });
    expect(onConfirm).toHaveBeenCalledWith(200, false);
  });
  it('shows a callback failure inline and allows the next explicit attempt', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(undefined);
    render(<BuyInModal {...base} onConfirm={onConfirm} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Buy Chips'));
    });
    expect(screen.getByRole('alert').textContent).toContain('Unable To Confirm');
    await act(async () => {
      fireEvent.click(screen.getByText('Buy Chips'));
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

it('shows an explicit unsuccessful callback result without relying on a toast', async () => {
  render(<BuyInModal {...base} onConfirm={async () => false} />);
  await act(async () => {
    fireEvent.click(screen.getByText('Buy Chips'));
  });
  expect(screen.getByRole('alert').textContent).toContain('Buy-In Not Yet Confirmed');
});

it.each([0, null])(
  'allows receipt recovery even when the current balance is %s',
  async (balance) => {
    const onConfirm = vi.fn().mockResolvedValue(false);
    render(
      <BuyInModal
        {...base}
        accountBalance={balance}
        minBuyIn={200}
        maxBuyIn={400}
        recovery={{ amount: 100, seat: 2 }}
        onConfirm={onConfirm}
      />
    );
    expect(screen.queryByRole('slider')).toBeNull();
    const retry = screen.getByRole('button', { name: 'Retry Original Buy-In' });
    expect(retry.hasAttribute('disabled')).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(100, false));
  }
);
