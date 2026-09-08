/**
 * Rebuy and Add-On quoted a price ~10% below what the server charged.
 *
 * `TournamentService.processRebuy` / `processAddOn` debit
 * `base + calcTournamentFee(base)` (10% by default, per Dan's "10% on any and
 * all tournament and SNG buy-ins" rule). Both modals printed the BASE cost and
 * computed `canAfford = walletBalance >= base`. A player holding
 * `base <= balance < base + fee` therefore saw an enabled Confirm button on a
 * purchase the server was guaranteed to reject.
 *
 * AddOnModal separately announced "Add-On Accepted — +N chips added" whenever
 * `onAccept()` resolved, and the parent handler caught its own errors, so every
 * failed add-on was reported to the player as a success.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import RebuyModal from '../src/components/table/RebuyModal';
import AddOnModal from '../src/components/table/AddOnModal';

vi.mock('../src/services/SoundService', () => ({
  haptic: { light: vi.fn(), medium: vi.fn(), heavy: vi.fn() },
  soundService: { playBuyInConfirm: vi.fn() },
}));

describe('RebuyModal charges what it advertises', () => {
  const base = { isOpen: true, rebuyCost: 100, rebuyFee: 10, rebuyChips: 10000 };

  it('shows the fee and the total, not just the base cost', () => {
    render(
      <RebuyModal
        {...base}
        walletBalance={500}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        isProcessing={false}
      />
    );
    expect(screen.getByText('House Fee')).toBeTruthy();
    expect(screen.getByText('Total Charged')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Rebuy 110/ })).toBeTruthy();
  });

  it('disables Confirm when the wallet covers the base but not the fee', () => {
    render(
      <RebuyModal
        {...base}
        walletBalance={105}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        isProcessing={false}
      />
    );
    const confirm = screen.getByRole('button', { name: /Rebuy 110/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // Dan 2026-08-20: tournament and SNG money renders in WHOLE chips, so the
    // shortfall line reads "110", not "110.00". The point of the assertion is
    // unchanged: it must name the TOTAL the server will charge, not the base.
    expect(screen.getByText(/you need 110 to rebuy/i)).toBeTruthy();
    expect(screen.queryByText(/110\.00/)).toBeNull();
  });

  it('enables Confirm once the wallet covers the total', () => {
    render(
      <RebuyModal
        {...base}
        walletBalance={110}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        isProcessing={false}
      />
    );
    expect((screen.getByRole('button', { name: /Rebuy 110/ }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('does not fire onConfirm when it cannot afford the total', () => {
    const onConfirm = vi.fn();
    render(
      <RebuyModal
        {...base}
        walletBalance={105}
        onConfirm={onConfirm}
        onClose={vi.fn()}
        isProcessing={false}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Rebuy 110/ }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('AddOnModal charges what it advertises', () => {
  const base = {
    isVisible: true,
    addOnCost: 100,
    addOnFee: 10,
    addOnChips: 10000,
    timeRemaining: 60,
  };

  it('gates on the fee-inclusive total', () => {
    render(<AddOnModal {...base} walletBalance={105} onAccept={vi.fn()} onDecline={vi.fn()} />);
    const accept = screen.getByRole('button', { name: /Accept For 110/ }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(screen.getByText(/you need 110 chips/i)).toBeTruthy();
  });

  it('refuses to sell at an unknown (zero) price', () => {
    render(
      <AddOnModal
        {...base}
        addOnCost={0}
        addOnFee={0}
        walletBalance={5000}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />
    );
    const accept = screen.getByRole('button', { name: /Accept Add-On/ }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(screen.getByText(/price unavailable/i)).toBeTruthy();
  });

  it('reports a refused add-on as a failure, not a success', async () => {
    render(
      <AddOnModal
        {...base}
        walletBalance={5000}
        onAccept={vi.fn().mockResolvedValue(false)}
        onDecline={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept For 110/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/Add-On Failed/);
    expect(screen.queryByText(/Add-On Accepted/)).toBeNull();
  });

  it('still reports success when the add-on goes through', async () => {
    render(
      <AddOnModal
        {...base}
        walletBalance={5000}
        onAccept={vi.fn().mockResolvedValue(true)}
        onDecline={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept For 110/ }));
    await waitFor(() => expect(screen.getByText(/Add-On Accepted/)).toBeTruthy());
  });

  it('accepts once when the button is double-tapped', async () => {
    let resolve!: (v: boolean) => void;
    const gate = new Promise<boolean>((r) => {
      resolve = r;
    });
    const onAccept = vi.fn().mockReturnValue(gate);
    render(<AddOnModal {...base} walletBalance={5000} onAccept={onAccept} onDecline={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /Accept For 110/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onAccept).toHaveBeenCalledTimes(1);
    resolve(true);
    await waitFor(() => expect(screen.getByText(/Add-On Accepted/)).toBeTruthy());
  });

  it('counts down from the persisted deadline instead of resetting to 60 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'));
    const onDecline = vi.fn();
    render(
      <AddOnModal
        {...base}
        timeRemaining={60}
        endsAtMs={Date.now() + 3_600_000}
        walletBalance={5000}
        onAccept={vi.fn()}
        onDecline={onDecline}
      />
    );

    expect(screen.getByText('3600s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(3_599_000));
    expect(screen.getByText('1s')).toBeTruthy();
    expect(onDecline).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('0s')).toBeTruthy();
    expect(onDecline).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
