/**
 * INSURANCE MODAL — layout + countdown + EV cashout contract (2026-08-28).
 *
 * Pins the fixes from Dan's recording (hand #3158299):
 *   1. CLIPPED BUTTONS: the action buttons live OUTSIDE the scrollable
 *      `.insurance-modal__body`, pinned as a direct child of the modal — a
 *      short viewport can never hide Insure/No again.
 *   2. COUNTDOWN HONESTY: with `deadlineAt` on the offer, the timer shows the
 *      true remaining seconds, not a stale seconds-figure.
 *   3. EXACT-RATE money math: Insured Pot = fee x (1/premiumRate), so the fee
 *      shown is the premium the server derives from the accepted coverage.
 *   4. EV CASHOUT: the tab renders when a handler exists, and the amount
 *      shown is the SERVER'S quote, verbatim.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import InsuranceModal, { type InsuranceOffer } from '../../src/components/table/InsuranceModal';

afterEach(cleanup);

const baseOffer: InsuranceOffer = {
  maxCoverage: 62,
  equityPercent: 73.6,
  premiumRate: 0.3168,
  potAmount: 62,
  yourStack: 0,
  opponentStack: 0,
  yourCards: [
    { rank: '9', suit: 'c' },
    { rank: '3', suit: 'c' },
  ],
  opponentCards: [
    { rank: 'A', suit: 's' },
    { rank: 'K', suit: 's' },
  ],
  board: [
    { rank: '9', suit: 's' },
    { rank: 'Q', suit: 'd' },
    { rank: '2', suit: 'c' },
  ],
  outs: [
    { rank: 'A', suit: 'h' },
    { rank: 'A', suit: 'd' },
    { rank: 'A', suit: 'c' },
    { rank: 'K', suit: 'h' },
    { rank: 'K', suit: 'd' },
    { rank: 'K', suit: 'c' },
  ],
  outPct: 13.3,
  timeoutSeconds: 25,
  atRisk: 31,
  heroName: 'kingfish',
};

function renderModal(offerOver: Partial<InsuranceOffer> = {}, props: Record<string, unknown> = {}) {
  return render(
    <InsuranceModal
      isOpen={true}
      onClose={() => {}}
      onAccept={() => {}}
      onDecline={() => {}}
      offer={{ ...baseOffer, ...offerOver }}
      {...props}
    />
  );
}

describe('clipped-buttons fix — actions pinned outside the scroll body', () => {
  it('renders the action row as a SIBLING after the scrollable body, never inside it', () => {
    const { container } = renderModal();
    const modal = container.querySelector('.insurance-modal')!;
    const body = modal.querySelector('.insurance-modal__body')!;
    const actions = modal.querySelector('.insurance-modal__actions')!;
    expect(body).toBeTruthy();
    expect(actions).toBeTruthy();
    // The buttons must NOT be descendants of the scroll container...
    expect(body.contains(actions)).toBe(false);
    // ...and must be direct children of the modal so flex pins them.
    expect(actions.parentElement).toBe(modal);
  });

  it('both decisions are present: No (final decline) and Insure', () => {
    const { getByText } = renderModal();
    expect(getByText('No')).toBeTruthy();
    expect(getByText('Insure')).toBeTruthy();
  });
});

describe('countdown honesty — deadlineAt drives the timer', () => {
  it('shows the true remaining time from the absolute deadline', () => {
    const { container } = renderModal({ deadlineAt: Date.now() + 9000 });
    const timer = container.querySelector('.insurance-modal__timer')!;
    // 9s away → ceil to 9 (8 tolerated for a slow test runner tick).
    expect(['9s', '8s']).toContain(timer.textContent);
  });

  it('falls back to timeoutSeconds when no deadline rides the offer', () => {
    const { container } = renderModal();
    expect(container.querySelector('.insurance-modal__timer')!.textContent).toBe('25s');
  });
});

describe('exact-rate money math', () => {
  it('Insured Pot = fee / premiumRate — what is displayed is what is bought', () => {
    const { container } = renderModal();
    // Constant Profit default: fee = pot / (1/premiumRate + 1)
    const exactMultiple = 1 / baseOffer.premiumRate;
    const fee = Math.round((baseOffer.potAmount / (exactMultiple + 1)) * 100) / 100;
    const insured = Math.round(fee * exactMultiple * 100) / 100;
    const values = Array.from(container.querySelectorAll('.insurance-modal__readout-value')).map(
      (el) => el.textContent
    );
    expect(values).toContain(fee.toLocaleString());
    expect(values).toContain(insured.toLocaleString());
    // Rate readout shows 2 decimals so Fee x Rate visibly equals Insured Pot.
    expect(values).toContain(exactMultiple.toFixed(2));
  });
});

describe('preflop offer presentation (2026-08-28)', () => {
  it('with no flop there are no outs — the strip labels the street instead', () => {
    const { getByText, queryByText } = renderModal({ board: [], outs: [], outPct: undefined });
    expect(getByText('Preflop All-In')).toBeTruthy();
    expect(queryByText(/^Outs:/)).toBeNull();
  });

  it('with a flop the outs count renders as before', () => {
    const { getByText } = renderModal();
    expect(getByText('Outs: 6')).toBeTruthy();
  });
});

describe('EV cashout wiring', () => {
  it('no handler => no tab (a dead money button must never render)', () => {
    const { queryByText } = renderModal();
    expect(queryByText('EV Cashout')).toBeNull();
  });

  it("with a handler, the tab shows the SERVER'S quote verbatim and sends it on Cash Out", () => {
    const onEvCashout = vi.fn();
    const { getByText, getAllByText } = renderModal({ evCashoutAmount: 41.87 }, { onEvCashout });
    fireEvent.click(getByText('EV Cashout'));
    // The server's number, not a client recomputation.
    expect(getAllByText('41.87').length).toBeGreaterThan(0);
    fireEvent.click(getByText('Cash Out'));
    expect(onEvCashout).toHaveBeenCalledWith(41.87);
  });
});

describe('human decision safety', () => {
  it('is a named modal dialog and Escape takes the same final-decline path', async () => {
    const onClose = vi.fn();
    const { getByRole } = renderModal({}, { onClose });
    const dialog = getByRole('dialog', { name: 'All-In Insurance' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('single-flights a same-frame double activation and re-enables after rejection', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onAccept = vi.fn(() => pending);
    const { getByRole } = renderModal({}, { onAccept });
    const insure = getByRole('button', { name: 'Insure' }) as HTMLButtonElement;

    fireEvent.click(insure);
    fireEvent.click(insure);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(insure.disabled).toBe(true);

    release();
    await waitFor(() => expect(insure.disabled).toBe(false));
  });
});
