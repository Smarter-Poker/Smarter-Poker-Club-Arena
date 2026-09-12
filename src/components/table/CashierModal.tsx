/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER MODAL — Add Chips at Table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium cashier modal for:
 * - Adding chips during play (up to the table maximum)
 * - Balance display
 * - Transaction history
 *
 * CHIP CONTINUITY (Operation Table Stakes, Slice 0, 2026-09-04): the second
 * tab is gone. Chips on a cash table stay on the table until the player leaves
 * (OPORD 1.3 invariant I1). There is no partial cash-out anywhere in the
 * client, the engine or the database, and this modal must not grow one back.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { haptic } from '../../services/SoundService';
import './CashierModal.css';
import { reportError } from '../../utils/errorReporter';
import { uuid } from '../../utils/uuid';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface CashierTransaction {
  id: string;
  type: 'add' | 'withdraw';
  amount: number;
  timestamp: Date;
  balance: number;
}

export interface CashierModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Resolve TRUE only when the chips actually moved. Resolving FALSE keeps the
   * modal open with the amount intact so the player can retry or correct it.
   *
   * This is deliberately `Promise<boolean>` and NOT `Promise<boolean | void>`.
   * The original bug was a handler that resolved `void` on every rejection
   * path, which the modal could not distinguish from success — so it closed as
   * if the top-up had worked. On 2026-08-20 that regressed once already, when a
   * merge reverted TablePage's handlers back to `void` while this file kept the
   * boolean check: it still compiled, and the bug came back silently. Requiring
   * the boolean makes that revert a build error instead.
   */
  /** `opId` is the modal's per-attempt idempotency id (see opIdRef). */
  onAddChips: (amount: number, opId?: string) => Promise<boolean>;
  currentStack: number;
  /** null = unknown (a failed read). Nothing can be added until it is known. */
  accountBalance: number | null;
  maxBuyIn: number;
  maxStack: number; // Max stack allowed at table
  transactions?: CashierTransaction[];
  currency?: string;
  isProcessing?: boolean;
  /** Diamonds are whole units: every amount this modal offers or accepts is an
   *  integer, because the custody door refuses a fraction. */
  wholeUnits?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// EXACT precision — no abbreviations, no rounding
function formatAmount(amount: number, currency: string = ''): string {
  if (Math.abs(amount - Math.round(amount)) < 0.005) {
    return Math.round(amount).toLocaleString('en-US');
  }
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Parse a user-typed amount to a non-negative, cent-accurate number inside the
 * allowed range. Returns 0 for anything unparseable so the confirm button stays
 * disabled rather than submitting NaN.
 */
function clampToCents(raw: string | number, max: number, wholeUnits = false): number {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ceiling = Number.isFinite(max) && max > 0 ? max : n;
  /* A Diamond does not divide. Rounding a typed 10.6 UP to 11 would ask the
     custody door for a unit the player did not choose, and it refuses a
     fraction outright, so the only honest direction here is down. */
  if (wholeUnits) return Math.floor(Math.min(n, ceiling));
  return Math.round(Math.min(n, ceiling) * 100) / 100;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function CashierModal({
  isOpen,
  onClose,
  onAddChips,
  currentStack,
  accountBalance,
  maxBuyIn,
  maxStack,
  transactions = [],
  currency = '',
  isProcessing = false,
  wholeUnits = false,
}: CashierModalProps) {
  const [amount, setAmount] = useState(0);
  // The quick-amount buttons animate in. They used to start as [] — which
  // renders every one of them at opacity: 0 — and only got seeded inside
  // handleTabChange, so on first open 25/50/75/MAX were invisible (but still
  // clickable) until you tapped a tab. Seed them true; the open effect replays
  // the stagger.
  const [visibleQuick] = useState<boolean[]>([true, true, true, true]);
  // In-flight guard. `isProcessing` is an optional prop no caller passes, so it
  // was never able to stop a double tap on Confirm from firing two top-ups.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * Per-ATTEMPT idempotency id (Cashier audit 2026-08-27, P0-1). Minted
   * lazily, held across retries of the same attempt — a Confirm re-tap after
   * a transport failure re-sends under the SAME id, so the engine's
   * atomic_table_addon key de-duplicates instead of debiting twice. Rotated
   * when the amount or tab changes (a different attempt) and on success
   * (that attempt is settled). Deliberately NOT rotated on failure — the
   * failure is the case the key exists for. Same shape as
   * WalletCashierModal.opIdRef.
   */
  const opIdRef = useRef<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Held in a ref so the focus-trap effect does not re-run (and re-steal focus)
  // every time the parent re-renders with a fresh inline onClose closure.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Calculate limits
  const balanceKnown = accountBalance !== null;
  const canAddAmount = useMemo(() => {
    const spaceInStack = maxStack - currentStack;
    // An unknown balance affords nothing - and says "Unavailable", not 0.
    if (accountBalance === null) return 0;
    return Math.min(spaceInStack, accountBalance, maxBuyIn);
  }, [currentStack, maxStack, accountBalance, maxBuyIn]);

  const activeMax = canAddAmount;

  // Quick amount options
  const quickAmounts = useMemo(() => {
    const max = canAddAmount;
    if (wholeUnits) {
      return [
        { label: '25%', value: Math.floor(max * 0.25) },
        { label: '50%', value: Math.floor(max * 0.5) },
        { label: '75%', value: Math.floor(max * 0.75) },
        { label: 'MAX', value: Math.floor(max) },
      ];
    }
    return [
      { label: '25%', value: Math.trunc(max * 0.25 * 100) / 100 },
      { label: '50%', value: Math.trunc(max * 0.5 * 100) / 100 },
      { label: '75%', value: Math.trunc(max * 0.75 * 100) / 100 },
      // To the cent like its three siblings (2026-09-09). `max` is
      // `Math.min(maxStack - currentStack, accountBalance, maxBuyIn)` - a
      // subtraction, so a float artifact - and MAX was the one preset that
      // reached `atomic_table_addon` without passing through `clampToCents`.
      { label: 'MAX', value: Math.trunc(max * 100) / 100 },
    ];
  }, [canAddAmount, wholeUnits]);

  // A changed amount is a DIFFERENT attempt — it gets its own idempotency
  // id. (After a failed attempt it is unchanged, so the held id survives for
  // the retry, which is the point.)
  useEffect(() => {
    opIdRef.current = null;
  }, [amount]);

  // Handle confirm
  const handleConfirm = useCallback(async () => {
    // busyRef, not the `busy` state: two taps inside one React batch both read
    // the stale state value and both would go through.
    if (amount <= 0 || isProcessing || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    haptic.medium();

    try {
      if (!opIdRef.current) opIdRef.current = uuid();
      const ok = await onAddChips(amount, opIdRef.current);
      if (!ok) {
        /* Cashier audit 2026-08-27 (P0-1): this banner used to assert "your
           wallet was not charged" / "your stack is unchanged" for EVERY
           failure — true for a server refusal, false for a transport failure
           where the request committed and the response was lost. This modal
           only sees a boolean, so it must not make a claim it cannot back;
           the toast from the handler carries the specific verdict (refusal
           vs unknown-outcome), and this banner points at the number that
           settles it. */
        setSubmitError(
          'That Top-Up Did Not Complete. Check Your Stack And Balance Before Trying Again.'
        );
        return;
      }
      opIdRef.current = null; // attempt settled — the next one is its own transaction
      setAmount(0);
      onClose();
    } catch (error) {
      reportError(error, 'CashierModal.Cashier_error');
      setSubmitError(
        safeErrorMessage(error, 'Something went wrong. Nothing was moved - please try again.')
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [amount, isProcessing, onAddChips, onClose]);

  // Validate amount
  const isValidAmount = useMemo(() => {
    if (amount <= 0) return false;
    return amount <= canAddAmount;
  }, [amount, canAddAmount]);

  // ── Focus Trap: trap focus inside modal when open ──
  const handleFocusTrap = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Never dismiss mid-request: the player would lose the only surface
      // that tells them whether the chips moved.
      if (busyRef.current) return;
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !modalRef.current) return;

    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  // Fresh state on every open. Without this the modal reopens showing the
  // previous attempt's amount and error banner.
  useEffect(() => {
    if (!isOpen) return;
    setAmount(0);
    setSubmitError(null);
    busyRef.current = false;
    setBusy(false);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.addEventListener('keydown', handleFocusTrap);
      const t = setTimeout(() => {
        if (modalRef.current) {
          const first = modalRef.current.querySelector<HTMLElement>('input, button');
          first?.focus();
        }
      }, 100);
      return () => {
        document.removeEventListener('keydown', handleFocusTrap);
        clearTimeout(t);
        previousFocusRef.current?.focus();
      };
    }
  }, [isOpen, handleFocusTrap]);

  if (!isOpen) return null;

  return (
    <div
      className="cashier-overlay"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="table-cashier-title"
    >
      <div className="cashier-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="cashier-modal__header">
          <h2 id="table-cashier-title" className="cashier-modal__title">
            Cashier
          </h2>
          <button
            className="cashier-modal__close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close Cashier"
          >
            ×
          </button>
        </div>

        {/* Balance Summary */}
        <div className="cashier-modal__summary">
          <div className="cashier-modal__balance-item">
            <span className="cashier-modal__balance-label">At Table</span>
            <span className="cashier-modal__balance-value">
              {formatAmount(currentStack, currency)}
            </span>
          </div>
          <div className="cashier-modal__balance-item">
            <span className="cashier-modal__balance-label">Account</span>
            <span className="cashier-modal__balance-value">
              {balanceKnown ? formatAmount(accountBalance, currency) : 'Unavailable'}
            </span>
          </div>
        </div>

        {/* One action: Add Chips. */}
        <div className="cashier-modal__tabs" aria-hidden="true">
          <span
            id="table-cashier-tab-add"
            className="cashier-modal__tab cashier-modal__tab--active"
          >
            Add Chips
          </span>
        </div>

        {/* Amount Input */}
        <div
          className="cashier-modal__input-section"
          id="table-cashier-panel-add"
          role="group"
          aria-labelledby="table-cashier-tab-add"
        >
          <div className="cashier-modal__input-wrapper">
            <span className="cashier-modal__currency">{currency}</span>
            {/* parseInt threw away the cents on every 25/50/75/MAX value (they are
                truncated to 2dp), so editing after a quick tap silently changed the
                amount. parseFloat + snap-to-cent keeps them. */}
            <input
              type="number"
              className="cashier-modal__input"
              value={amount || ''}
              onChange={(e) => setAmount(clampToCents(e.target.value, activeMax, wholeUnits))}
              onBlur={() => setAmount((prev) => clampToCents(prev, activeMax, wholeUnits))}
              placeholder="0"
              min={0}
              step={wholeUnits ? 1 : 0.01}
              max={activeMax}
              disabled={busy}
              aria-label="Amount To Add"
              aria-invalid={amount > 0 && !isValidAmount}
            />
          </div>
          <div className="cashier-modal__limit">
            <span>Available To Add: {formatAmount(canAddAmount, currency)}</span>
          </div>
        </div>

        {/* Quick Amounts */}
        <div className="cashier-modal__quick-amounts">
          {quickAmounts.map(({ label, value }, idx) => (
            <button
              key={label}
              className={`cashier-modal__quick-btn ${amount === value ? 'cashier-modal__quick-btn--active' : ''}`}
              type="button"
              onClick={() => {
                setSubmitError(null);
                setAmount(value);
              }}
              disabled={value <= 0 || busy}
              aria-pressed={amount === value}
              style={{
                opacity: visibleQuick[idx] ? 1 : 0,
                transform: visibleQuick[idx] ? 'scale(1)' : 'scale(0.85)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* New Stack Preview */}
        <div className="cashier-modal__preview">
          <span className="cashier-modal__preview-label">New Stack:</span>
          <span className="cashier-modal__preview-value cashier-modal__preview-value--add">
            {formatAmount(currentStack + amount, currency)}
          </span>
        </div>

        {/* Failure notice — the modal used to close as if it had worked */}
        {submitError && (
          <div className="cashier-modal__error" role="alert" aria-live="assertive">
            {submitError}
          </div>
        )}

        {/* Confirm Button */}
        <div className="cashier-modal__actions">
          <button
            type="button"
            className={`cashier-modal__confirm-btn ${!isValidAmount || isProcessing || busy ? 'cashier-modal__confirm-btn--disabled' : ''}`}
            onClick={handleConfirm}
            disabled={!isValidAmount || isProcessing || busy}
          >
            {isProcessing || busy ? (
              <>
                <span className="cashier-modal__spinner" />
                Processing...
              </>
            ) : (
              `Add ${formatAmount(amount, currency)}`
            )}
          </button>
        </div>

        {/* Recent Transactions */}
        {transactions.length > 0 && (
          <div className="cashier-modal__transactions">
            <span className="cashier-modal__transactions-title">Recent</span>
            <div className="cashier-modal__transactions-list">
              {transactions.slice(0, 5).map((tx) => (
                <div key={tx.id} className="cashier-modal__transaction">
                  <span className={`cashier-modal__tx-type cashier-modal__tx-type--${tx.type}`}>
                    {tx.type === 'add' ? '+' : '-'}
                    {formatAmount(tx.amount, currency)}
                  </span>
                  <span className="cashier-modal__tx-time">{formatTime(tx.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default CashierModal;
