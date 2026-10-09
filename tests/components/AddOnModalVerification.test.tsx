import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import AddOnModal from '../../src/components/table/AddOnModal';

vi.mock('../../src/services/SoundService', () => ({
  haptic: { light: vi.fn(), medium: vi.fn(), heavy: vi.fn() },
  soundService: { playBuyInConfirm: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T18:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const offer = {
  isVisible: true,
  addOnCost: 1,
  addOnFee: 0,
  addOnChips: 10000,
  walletBalance: 2389.18,
  timeRemaining: 3,
};

describe('Add-on popup verified behavior', () => {
  it('prints one chip in the singular and never restores Total Charged', () => {
    render(<AddOnModal {...offer} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText('Add-On Cost').closest('.addon-console__row')?.textContent).toBe(
      'Add-On Cost1 Chip'
    );
    expect(screen.queryByText('Total Charged')).toBeNull();
    expect(screen.queryByText('1 Chips')).toBeNull();
  });

  it('uses singular chip labels for a one-chip wallet, award and confirmation', async () => {
    render(
      <AddOnModal
        {...offer}
        walletBalance={1}
        addOnChips={1}
        onAccept={vi.fn().mockResolvedValue(true)}
        onDecline={vi.fn()}
      />
    );
    expect(screen.getByText('Your Balance').closest('.addon-console__row')?.textContent).toBe(
      'Your Balance1 Chip'
    );
    expect(screen.getByText('Chips Received').closest('.addon-console__row')?.textContent).toBe(
      'Chips Received+1 Chip'
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Accept For 1' })));
    expect(screen.getByText('Add-On Accepted - +1 Chip Added')).toBeTruthy();
  });

  it('counts down and expires without a persisted deadline', () => {
    const onDecline = vi.fn();
    render(<AddOnModal {...offer} onAccept={vi.fn()} onDecline={onDecline} />);
    expect(screen.getByText('3s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('2s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('0s')).toBeTruthy();
    expect(onDecline).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(3000));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('does not extend the fallback deadline on an unrelated balance render', () => {
    const onDecline = vi.fn();
    const onAccept = vi.fn();
    const { rerender } = render(
      <AddOnModal {...offer} onAccept={onAccept} onDecline={onDecline} />
    );
    act(() => vi.advanceTimersByTime(2000));
    rerender(
      <AddOnModal {...offer} walletBalance={100} onAccept={onAccept} onDecline={onDecline} />
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Accept For 1' })).toBeDisabled();
  });

  it('rejects a click after elapsed wall time even before the next timer tick', () => {
    const onAccept = vi.fn();
    render(<AddOnModal {...offer} onAccept={onAccept} onDecline={vi.fn()} />);
    vi.setSystemTime(Date.now() + 10000);
    fireEvent.click(screen.getByRole('button', { name: 'Accept For 1' }));
    expect(onAccept).not.toHaveBeenCalled();
  });

  it.each(['button', 'cross', 'escape'])(
    'dismisses a confirmed receipt using %s',
    async (method) => {
      const onDecline = vi.fn();
      render(
        <AddOnModal {...offer} onAccept={vi.fn().mockResolvedValue(true)} onDecline={onDecline} />
      );
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Accept For 1' })));
      if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      else if (method === 'cross')
        fireEvent.click(screen.getByRole('button', { name: 'Close Add-On' }));
      else fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(onDecline).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Add-On Accepted/)).toBeTruthy();
      expect(screen.queryByText(/Add-On Declined/)).toBeNull();
    }
  );

  it('dismisses an unknown result at most once without repeating a purchase', async () => {
    const onDecline = vi.fn();
    const onAccept = vi.fn().mockResolvedValue(false);
    render(<AddOnModal {...offer} onAccept={onAccept} onDecline={onDecline} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Accept For 1' })));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Add-On' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry Confirmation' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('does not auto-decline again if props update after a manual decline', () => {
    const onDecline = vi.fn();
    const onAccept = vi.fn();
    const { rerender } = render(
      <AddOnModal {...offer} onAccept={onAccept} onDecline={onDecline} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    rerender(
      <AddOnModal
        {...offer}
        endsAtMs={Date.now() - 1000}
        onAccept={onAccept}
        onDecline={onDecline}
      />
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['infinite price', { addOnCost: Infinity }],
    ['non-number price', { addOnCost: NaN }],
    ['invalid fee', { addOnFee: Infinity }],
    ['infinite wallet', { walletBalance: Infinity }],
    ['unknown wallet', { walletBalance: NaN }],
    ['unknown chip award', { addOnChips: NaN }],
    ['infinite chip award', { addOnChips: Infinity }],
    ['empty chip award', { addOnChips: 0 }],
  ])('does not enable a purchase or display fake values for %s', (_name, values) => {
    const onAccept = vi.fn();
    const { container } = render(
      <AddOnModal {...offer} {...values} onAccept={onAccept} onDecline={vi.fn()} />
    );
    const accept = screen.getByRole('button', { name: /Accept/ });
    expect(accept).toBeDisabled();
    fireEvent.click(accept);
    expect(onAccept).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/NaN|Infinity|∞/);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('reopens with a fresh fallback deadline after the presentation is hidden', () => {
    const onDecline = vi.fn();
    const onAccept = vi.fn();
    const { rerender } = render(
      <AddOnModal {...offer} onAccept={onAccept} onDecline={onDecline} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    rerender(<AddOnModal {...offer} isVisible={false} onAccept={onAccept} onDecline={onDecline} />);
    act(() => vi.advanceTimersByTime(10000));
    rerender(<AddOnModal {...offer} onAccept={onAccept} onDecline={onDecline} />);
    expect(screen.getByText('3s')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept For 1' })).toBeEnabled();
    act(() => vi.advanceTimersByTime(3000));
    expect(onDecline).toHaveBeenCalledTimes(2);
  });
});
