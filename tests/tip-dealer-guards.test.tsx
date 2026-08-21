/**
 * Tip Dealer was dead code with two live bugs inside it.
 *
 *  1. UNREACHABLE. `setShowTipDealer(true)` was never called anywhere in the
 *     app, so the modal, its CSS and its handler had never run. Confirmed
 *     against prod: `select count(*) from wallet_transactions where category
 *     ilike '%tip%'` returned 0.
 *  2. The custom-amount submit button gated on `!customAmount` — the truthiness
 *     of the STRING — so "0" (a non-empty string) left Tip enabled on a tip
 *     that can never succeed, as did "-5".
 *  3. No in-flight guard: `onTip` was fired and `onClose()` called immediately,
 *     so a double tap sent two tips and the modal closed before the result was
 *     known.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TipDealer } from '../src/components/table/TipDealer';

vi.mock('../src/services/SoundService', () => ({
  haptic: { light: vi.fn(), medium: vi.fn(), heavy: vi.fn() },
  soundService: { playBuyInConfirm: vi.fn() },
}));

const base = { isOpen: true, balance: 500, defaultAmounts: [1, 5, 25, 100] };

describe('TipDealer custom amount validation', () => {
  it('keeps Tip disabled for "0"', () => {
    render(<TipDealer {...base} onClose={vi.fn()} onTip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Custom tip amount'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Tip' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps Tip disabled for a negative amount', () => {
    render(<TipDealer {...base} onClose={vi.fn()} onTip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Custom tip amount'), { target: { value: '-5' } });
    expect((screen.getByRole('button', { name: 'Tip' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps Tip disabled above the table stack', () => {
    render(<TipDealer {...base} onClose={vi.fn()} onTip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Custom tip amount'), { target: { value: '501' } });
    expect((screen.getByRole('button', { name: 'Tip' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Tip for a valid amount and sends it', async () => {
    const onTip = vi.fn().mockResolvedValue(undefined);
    render(<TipDealer {...base} onClose={vi.fn()} onTip={onTip} />);
    fireEvent.change(screen.getByLabelText('Custom tip amount'), { target: { value: '12.5' } });
    const btn = screen.getByRole('button', { name: 'Tip' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(onTip).toHaveBeenCalledWith(12.5));
  });
});

describe('TipDealer in-flight behaviour', () => {
  it('sends one tip when a preset is double-tapped', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const onTip = vi.fn().mockReturnValue(gate);
    render(<TipDealer {...base} onClose={vi.fn()} onTip={onTip} />);
    const preset = screen.getAllByRole('button').find((b) => b.textContent?.includes('25'))!;
    fireEvent.click(preset);
    fireEvent.click(preset);
    fireEvent.click(preset);
    expect(onTip).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
      await gate;
    });
  });

  it('does not close itself — the caller closes only on success', async () => {
    const onClose = vi.fn();
    const onTip = vi.fn().mockResolvedValue(undefined);
    render(<TipDealer {...base} onClose={onClose} onTip={onTip} />);
    const preset = screen.getAllByRole('button').find((b) => b.textContent?.includes('25'))!;
    fireEvent.click(preset);
    await waitFor(() => expect(onTip).toHaveBeenCalled());
    // The old modal called onClose() unconditionally, immediately after firing
    // onTip — so a rejected tip looked exactly like an accepted one.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables presets the stack cannot cover', () => {
    render(<TipDealer {...base} balance={10} onClose={vi.fn()} onTip={vi.fn()} />);
    const preset = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('100')) as HTMLButtonElement;
    expect(preset.disabled).toBe(true);
  });
});
