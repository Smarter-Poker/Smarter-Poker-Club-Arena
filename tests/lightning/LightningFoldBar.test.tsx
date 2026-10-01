/**
 * LIGHTNING PHASE 6: the Lightning controls in the action area.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import LightningFoldBar from '../../src/components/table/LightningFoldBar';

afterEach(cleanup);

describe('LightningFoldBar', () => {
  it('offers LIGHTNING FOLD when folding is available and sends fast_fold', () => {
    const onFold = vi.fn();
    render(
      <LightningFoldBar
        availability={{ fastFold: true, foldWatch: false }}
        offerFoldWatch={false}
        onFold={onFold}
      />
    );
    const btn = screen.getByTestId('lightning-fold') as HTMLButtonElement;
    expect(btn.textContent).toBe('LIGHTNING FOLD');
    expect(btn.disabled).toBe(false);
    expect(screen.queryByTestId('lightning-fold-watch')).toBeNull();
    fireEvent.click(btn);
    expect(onFold).toHaveBeenCalledWith('fast_fold');
  });

  it('shows FOLD & WATCH only where the capability allows it', () => {
    const onFold = vi.fn();
    render(
      <LightningFoldBar
        availability={{ fastFold: true, foldWatch: true }}
        offerFoldWatch
        onFold={onFold}
      />
    );
    fireEvent.click(screen.getByTestId('lightning-fold-watch'));
    expect(onFold).toHaveBeenCalledWith('fold_watch');
  });

  it('keeps its place between hands: same node, words only dim', () => {
    const { rerender } = render(
      <LightningFoldBar
        availability={{ fastFold: true, foldWatch: true }}
        offerFoldWatch
        onFold={() => {}}
      />
    );
    const bar = screen.getByTestId('lightning-fold-bar');
    rerender(
      <LightningFoldBar
        availability={{ fastFold: false, foldWatch: false }}
        offerFoldWatch
        onFold={() => {}}
      />
    );
    expect(screen.getByTestId('lightning-fold-bar')).toBe(bar);
    expect(bar.getAttribute('data-live')).toBe('false');
    expect((screen.getByTestId('lightning-fold') as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <LightningFoldBar
        availability={{ fastFold: true, foldWatch: true }}
        offerFoldWatch
        onFold={() => {}}
      />
    );
    expect(screen.getByTestId('lightning-fold-bar')).toBe(bar);
    expect(bar.getAttribute('data-live')).toBe('true');
  });
});
