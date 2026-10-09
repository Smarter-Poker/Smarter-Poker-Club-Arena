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
import { PurchaseConsole, PurchaseText } from './PurchaseConsole';
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

// EXACT precision — no abbreviations, no rounding. `currency` is accepted for
// the callers' sake (the unit prints beside the figure, never inside it).
function formatAmount(amount: number, _currency: string = ''): string {
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

/**
 * WHAT THE PLAYER TYPED, BEFORE THE CAP (launch audit D-22). The field used to
 * clamp on every keystroke, so 500 against a 300 ceiling silently became 300
 * with no sentence, and `aria-invalid` could never be true. The raw text is
 * kept; it is read to the cent (or the whole unit), compared with the
 * ceiling for validity, and clamped only when the field is left, with a
 * sentence that says so. The spelling is digits and one point: an exponent
 * or a sign is refused rather than parsed.
 */
const AMOUNT_SPELLING = /^\d*\.?\d*$/;
function readAmount(text: string, wholeUnits: boolean): { amount: number; spelledOk: boolean } {
  const trimmed = text.trim();
  const spelledOk = trimmed === '' || AMOUNT_SPELLING.test(trimmed);
  const n = parseFloat(trimmed);
  if (!spelledOk || !Number.isFinite(n) || n <= 0) return { amount: 0, spelledOk };
  return { amount: wholeUnits ? Math.floor(n) : Math.round(n * 100) / 100, spelledOk };
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
  currency = '',
  isProcessing = false,
  wholeUnits = false,
}: CashierModalProps) {
  const [amountText, setAmountText] = useState('');
  const { amount, spelledOk } = readAmount(amountText, wholeUnits);
  const setAmount = useCallback((value: number) => {
    setAmountText(value > 0 ? String(value) : '');
  }, []);
  /** The sentence printed after the field was left over the ceiling. */
  const [capNote, setCapNote] = useState<string | null>(null);
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
      /* A thrown transport failure is the one case where the request may
         have committed and the response was lost, so this banner makes no
         claim about what moved (launch audit D-10): the same sentence as the
         refused branch, pointing at the figures that settle it. */
      setSubmitError(
        safeErrorMessage(
          error,
          'That Top-Up Did Not Complete. Check Your Stack And Balance Before Trying Again.'
        )
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [amount, isProcessing, onAddChips, onClose, setAmount]);

  // Validate amount
  const isValidAmount = useMemo(() => {
    if (!spelledOk || amount <= 0) return false;
    return amount <= canAddAmount;
  }, [amount, canAddAmount, spelledOk]);

  /* Leaving the field clamps what was typed to the ceiling and says so; the
     next keystroke clears the sentence. */
  const clampOnBlur = useCallback(() => {
    if (amount <= 0) return;
    const clamped = clampToCents(amount, activeMax, wholeUnits);
    if (clamped !== amount) {
      setAmount(clamped);
      setCapNote(`Capped At ${formatAmount(clamped)}`);
    }
  }, [amount, activeMax, wholeUnits, setAmount]);

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
      'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
    setCapNote(null);
    setSubmitError(null);
    busyRef.current = false;
    setBusy(false);
  }, [isOpen, setAmount]);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.addEventListener('keydown', handleFocusTrap);
      const t = setTimeout(() => {
        if (modalRef.current) {
          const first = modalRef.current.querySelector<HTMLElement>(
            'input:not([tabindex="-1"]), button'
          );
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

  const confirmDisabled = !isValidAmount || isProcessing || busy;
  const confirmLabel = isProcessing || busy ? 'Processing...' : `Add ${formatAmount(amount)}`;

  // Existing exact-amount, idempotency, busy and focus logic owns the purchase.
  const closeTopUp = () => {
    if (!busyRef.current && !isProcessing) onClose();
  };
  const unit = currency || 'Chips';
  const balanceValue = balanceKnown ? formatAmount(accountBalance, currency) : 'Unavailable';
  /* Everything the sheet has to say is printed INSIDE the painted frame
     (launch audit R-05): the refusal, the cap sentence and the ceiling share
     the status line under the amount, so nothing sits on bare black below
     the art. */
  const statusLine = submitError ? (
    <span className="cashier-error" role="alert" aria-live="assertive">
      {submitError}
    </span>
  ) : capNote ? (
    <span role="status">
      {capNote} {unit}
    </span>
  ) : !balanceKnown ? (
    <span role="status">Balance Unavailable</span>
  ) : (
    <span>
      Available To Add: {formatAmount(canAddAmount)} {unit}
    </span>
  );
  return (
    <div
      className="cashier-overlay addon-console__overlay"
      onClick={closeTopUp}
      role="dialog"
      aria-modal="true"
      aria-labelledby="table-cashier-title"
    >
      <div
        className="cashier-dialog addon-console"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <PurchaseConsole
          title="Add-On Available"
          titleId="table-cashier-title"
          subtitle={`At Table: ${formatAmount(currentStack)} ${unit}`}
          status={
            <>
              <input
                type="number"
                className="purchase-console__amount"
                value={amountText}
                onChange={(e) => {
                  setCapNote(null);
                  setSubmitError(null);
                  /* The ceiling and the whole-unit floor still apply as the
                     figure is typed (an over-max amount is never on screen
                     for a tap to send); what changed is that a clamp SAYS SO,
                     and a spelling the field cannot read stays on screen
                     marked invalid instead of vanishing into 0. */
                  const typed = e.target.value;
                  const n = parseFloat(typed);
                  if (!AMOUNT_SPELLING.test(typed.trim()) || !Number.isFinite(n) || n <= 0) {
                    setAmountText(typed);
                    return;
                  }
                  const clamped = clampToCents(n, activeMax, wholeUnits);
                  if (clamped < n && Number.isFinite(activeMax) && n > activeMax) {
                    setCapNote(`Capped At ${formatAmount(clamped)}`);
                  }
                  setAmountText(clamped === n ? typed : String(clamped));
                }}
                onBlur={clampOnBlur}
                placeholder="0"
                min={0}
                step={wholeUnits ? 1 : 0.01}
                max={activeMax}
                disabled={busy || isProcessing}
                aria-label="Amount To Add"
                aria-invalid={amountText.trim() !== '' && !isValidAmount}
              />
              {statusLine}
            </>
          }
          rows={[
            <React.Fragment key="cost">
              <span>Add-On Cost</span>
              <strong>
                <PurchaseText>{`${formatAmount(amount)} ${unit}`}</PurchaseText>
              </strong>
            </React.Fragment>,
            <React.Fragment key="stack">
              <span>New Stack</span>
              <strong>
                <PurchaseText>{`${formatAmount(currentStack + amount)} ${unit}`}</PurchaseText>
              </strong>
            </React.Fragment>,
            <React.Fragment key="balance">
              <span>Your Balance</span>
              <strong>
                <PurchaseText>
                  {balanceKnown ? `${balanceValue} ${unit}` : balanceValue}
                </PurchaseText>
              </strong>
            </React.Fragment>,
          ]}
          secondary={{
            label: 'Close',
            'aria-label': 'Close Cashier',
            onClick: closeTopUp,
            disabled: busy || isProcessing,
          }}
          primary={{ label: confirmLabel, onClick: handleConfirm, disabled: confirmDisabled }}
          onClose={closeTopUp}
          closeDisabled={busy || isProcessing}
          amountControls={
            <>
              {quickAmounts.map(({ label, value }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setSubmitError(null);
                    setCapNote(null);
                    setAmount(value);
                  }}
                  disabled={value <= 0 || busy || isProcessing}
                  aria-pressed={amount === value}
                >
                  {label}
                </button>
              ))}
            </>
          }
        />
      </div>
    </div>
  );
}

export default CashierModal;
