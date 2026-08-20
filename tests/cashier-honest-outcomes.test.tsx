/**
 * The cashier told players their chips had moved when they had not.
 *
 * `handleConfirm` awaited `onAddChips(amount)` and then unconditionally ran
 * `setAmount(0); onClose();`. The parent's `handleAddChips` returned `void` on
 * every rejection path (`if (!res.success) { ...; return; }`), and
 * `GameServerAPI.addChips` never throws — it resolves `{ success: false }` — so
 * the `catch` was unreachable dead code. Net effect: a refused top-up closed
 * the cashier exactly like a successful one.
 *
 * Separately, the only in-flight guard was the `isProcessing` PROP, which
 * `TableModalsLayer` never passed (defaulting it to `false`), so double-tapping
 * Confirm fired two top-ups.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CashierModal } from '../src/components/table/CashierModal';

const base = {
  isOpen: true,
  currentStack: 100,
  accountBalance: 1000,
  minBuyIn: 40,
  maxBuyIn: 200,
  maxStack: 400,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('CashierModal reports what actually happened', () => {
  it('stays open and explains itself when the engine refuses the top-up', async () => {
    const onClose = vi.fn();
    render(
      <CashierModal
        {...base}
        onClose={onClose}
        onAddChips={vi.fn().mockResolvedValue(false)}
        onWithdrawChips={vi.fn().mockResolvedValue(true)}
      />
    );

    fireEvent.click(screen.getByText('50%'));
    fireEvent.click(screen.getByRole('button', { name: /^Add / }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/not added/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the top-up succeeds', async () => {
    const onClose = vi.fn();
    render(
      <CashierModal
        {...base}
        onClose={onClose}
        onAddChips={vi.fn().mockResolvedValue(true)}
        onWithdrawChips={vi.fn().mockResolvedValue(true)}
      />
    );

    fireEvent.click(screen.getByText('50%'));
    fireEvent.click(screen.getByRole('button', { name: /^Add / }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not treat a void-resolving handler as success', async () => {
    // The contract is `Promise<boolean>`, enforced by the prop type. This test
    // pins the RUNTIME half of it: if a handler ever slips back to resolving
    // `undefined` (which is exactly what the original bug was, and what a merge
    // reverted TablePage to on 2026-08-20), the cashier must NOT close as
    // though the chips moved.
    const onClose = vi.fn();
    render(
      <CashierModal
        {...base}
        onClose={onClose}
        onAddChips={vi.fn().mockResolvedValue(undefined as unknown as boolean)}
        onWithdrawChips={vi.fn().mockResolvedValue(undefined as unknown as boolean)}
      />
    );

    fireEvent.click(screen.getByText('50%'));
    fireEvent.click(screen.getByRole('button', { name: /^Add / }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('charges once when Confirm is double-tapped', async () => {
    const gate = deferred<boolean>();
    const onAddChips = vi.fn().mockReturnValue(gate.promise);
    render(
      <CashierModal
        {...base}
        onClose={vi.fn()}
        onAddChips={onAddChips}
        onWithdrawChips={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('50%'));
    const confirm = screen.getByRole('button', { name: /^Add / });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onAddChips).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(true);
      await gate.promise;
    });
  });

  it('surfaces a thrown error instead of closing on it', async () => {
    const onClose = vi.fn();
    render(
      <CashierModal
        {...base}
        onClose={onClose}
        onAddChips={vi.fn().mockRejectedValue(new Error('wallet locked'))}
        onWithdrawChips={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('50%'));
    fireEvent.click(screen.getByRole('button', { name: /^Add / }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('wallet locked'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CashierModal quick amounts are visible on first open', () => {
  it('does not render the quick buttons at opacity 0 before a tab is clicked', () => {
    render(
      <CashierModal {...base} onClose={vi.fn()} onAddChips={vi.fn()} onWithdrawChips={vi.fn()} />
    );
    // `visibleQuick` started as [], so every button read visibleQuick[i] ===
    // undefined and rendered fully transparent — invisible, but clickable.
    for (const label of ['25%', '50%', '75%', 'MAX']) {
      const btn = screen.getByText(label) as HTMLElement;
      expect(btn.style.opacity).not.toBe('0');
    }
  });
});

describe('CashierModal amount input keeps cents', () => {
  it('does not truncate a fractional amount to an integer', () => {
    render(
      <CashierModal {...base} onClose={vi.fn()} onAddChips={vi.fn()} onWithdrawChips={vi.fn()} />
    );
    const input = screen.getByLabelText('Amount to add') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12.34' } });
    // parseInt('12.34') === 12 — the old code silently dropped the cents that
    // the 25/50/75/MAX buttons themselves produce.
    expect(input.value).toBe('12.34');
  });

  it('clamps an over-max amount rather than accepting it', () => {
    render(
      <CashierModal {...base} onClose={vi.fn()} onAddChips={vi.fn()} onWithdrawChips={vi.fn()} />
    );
    const input = screen.getByLabelText('Amount to add') as HTMLInputElement;
    // canAddAmount = min(maxStack - currentStack, accountBalance, maxBuyIn)
    //             = min(300, 1000, 200) = 200
    fireEvent.change(input, { target: { value: '999999' } });
    expect(Number(input.value)).toBe(200);
  });
});
