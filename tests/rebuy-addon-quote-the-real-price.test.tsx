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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import RebuyModal from '../src/components/table/RebuyModal';
import AddOnModal from '../src/components/table/AddOnModal';
import { tournamentService } from '../src/services/TournamentService';
import { TournamentPurchaseNotSubmittedError } from '../src/services/TournamentPurchaseIntent';

vi.mock('../src/services/SoundService', () => ({
  haptic: { light: vi.fn(), medium: vi.fn(), heavy: vi.fn() },
  soundService: { playBuyInConfirm: vi.fn() },
}));

afterEach(() => vi.useRealTimers());

describe('TournamentService uses the canonical cent-accurate fee split', () => {
  it.each([
    [1, 0.9, 0.1],
    [5, 4.5, 0.5],
    [15, 13.5, 1.5],
    [20, 18, 2],
  ])('quotes %s as %s prize plus %s fee', (total, prize, fee) => {
    expect(
      tournamentService.quoteFromTournament(
        {
          buy_in_amount: 90,
          buy_in_fee: 10,
          starting_chips: 1_000,
          rebuy_cost: total,
          rebuy_chips: 1_000,
        },
        'rebuy'
      )
    ).toEqual({ baseCost: prize, fee, totalCost: total, chips: 1_000 });
  });
});

describe('RebuyModal charges what it advertises', () => {
  const base = { isOpen: true, rebuyCost: 100, rebuyFee: 10, rebuyChips: 10000 };

  it('cannot decline from the backdrop or buttons while a purchase is pending', () => {
    const onClose = vi.fn();
    const { container } = render(
      <RebuyModal
        {...base}
        walletBalance={500}
        onConfirm={vi.fn()}
        onClose={onClose}
        isProcessing
      />
    );
    /* On the spade console (2026-09-08) the sheet has no close cross: the two
       painted plates are its only exits, and the backdrop. */
    fireEvent.click(container.querySelector('.rebuy-modal__overlay')!);
    fireEvent.click(screen.getByRole('button', { name: 'Decline Rebuy' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('retries an unconfirmed purchase even if the debit has lowered the displayed balance', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(
      <RebuyModal
        {...base}
        walletBalance={0}
        onConfirm={onConfirm}
        onClose={onClose}
        isProcessing={false}
        purchaseUnconfirmed
      />
    );
    fireEvent.click(container.querySelector('.rebuy-modal__overlay')!);
    fireEvent.click(screen.getByRole('button', { name: 'Decline Rebuy' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Confirmation' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

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

  it('adds the exact cent split before rendering the whole advertised price', () => {
    render(
      <RebuyModal
        {...base}
        rebuyCost={13.5}
        rebuyFee={1.5}
        walletBalance={15}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        isProcessing={false}
      />
    );
    expect(screen.getByText('13.50')).toBeTruthy();
    expect(screen.getByText('1.50')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Rebuy 15/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rebuy 16/ })).toBeNull();
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

  it('does not infer an unpaid wallet from an unconfirmed false result', async () => {
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
    expect(screen.getByRole('alert').textContent).toMatch(/Add-On Not Confirmed/);
    expect(screen.queryByText(/wallet was not charged/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry Confirmation' })).toBeTruthy();
    expect(screen.queryByText(/Add-On Accepted/)).toBeNull();
  });

  it('keeps an outstanding purchase open when its deadline expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'));
    let resolve!: (confirmed: boolean) => void;
    const onAccept = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        })
    );
    const onDecline = vi.fn();
    render(
      <AddOnModal
        {...base}
        endsAtMs={Date.now() + 1000}
        walletBalance={5000}
        onAccept={onAccept}
        onDecline={onDecline}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept For/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    act(() => vi.advanceTimersByTime(2000));
    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Processing...' })).toBeTruthy();
    await act(async () => resolve(true));
    expect(screen.getByText(/Add-On Accepted/)).toBeTruthy();
    expect(screen.queryByText(/Add-On Declined/)).toBeNull();
  });

  it('allows only confirmation retry after an unknown reply, expiry and a changed balance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'));
    const endsAtMs = Date.now() + 1000;
    const onAccept = vi
      .fn()
      .mockRejectedValueOnce(new Error('Lost reply'))
      .mockResolvedValueOnce(true);
    const onDecline = vi.fn();
    const { rerender } = render(
      <AddOnModal
        {...base}
        endsAtMs={endsAtMs}
        walletBalance={5000}
        onAccept={onAccept}
        onDecline={onDecline}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Accept For/ })));
    act(() => vi.advanceTimersByTime(2000));
    rerender(
      <AddOnModal
        {...base}
        endsAtMs={endsAtMs}
        walletBalance={0}
        onAccept={onAccept}
        onDecline={onDecline}
      />
    );
    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.queryByText(/wallet was not charged/i)).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Retry Confirmation' }))
    );
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Add-On Accepted/)).toBeTruthy();
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

  it('dismisses an unknown add-on without relabeling the purchase as declined', async () => {
    const onDecline = vi.fn();
    render(
      <AddOnModal
        {...base}
        walletBalance={5000}
        onAccept={vi.fn().mockResolvedValue(false)}
        onDecline={onDecline}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Accept For/ })));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDecline).toHaveBeenCalledOnce();
    expect(screen.getByText('Add-On Not Confirmed')).toBeTruthy();
    expect(screen.queryByText('Add-On Declined')).toBeNull();
  });

  it('allows a normal decline when the fresh purchase was provably never submitted', async () => {
    const onDecline = vi.fn();
    render(
      <AddOnModal
        {...base}
        walletBalance={5000}
        onAccept={vi
          .fn()
          .mockRejectedValue(
            new TournamentPurchaseNotSubmittedError(new Error('Quote unavailable'))
          )}
        onDecline={onDecline}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Accept For/ })));
    expect(screen.getByRole('alert').textContent).toContain('Was Not Submitted');
    expect(screen.queryByText('Add-On Not Confirmed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).toHaveBeenCalledOnce();
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
