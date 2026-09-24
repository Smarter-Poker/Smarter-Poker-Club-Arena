import {
  CASHOUT_AMOUNT_LIMIT,
  cashoutPercentage,
  validateCashoutAmount,
} from '../../utils/cashoutAmount';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHOUT REQUEST MODAL — Player Chip Cashout UI
 * ═══════════════════════════════════════════════════════════════════════════════
 * Modal for players to request chip cashouts from their agent
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { cashoutService, CashoutRequest } from '../../services/CashoutService';
import { CashoutReceiptChecks, useCashoutReceiptChecks } from './CashoutReceiptChecks';
import { useCashoutScope, useCashoutScopeKey } from '../../hooks/useCashoutScope';
import {
  runCashoutOperation,
  recoverCashoutOperation,
  captureCashoutStart,
  assertCashoutStartCurrent,
  type CashoutStart,
} from '../../services/CashoutOperation';
import {
  usePreparedCashoutOperations,
  isCashoutStartCurrent,
} from '../../hooks/usePreparedCashoutOperations';
import { masterBus } from '../../core/MasterBus';
import { checkSettlementLock } from '../../utils/settlementLock';
import { formatRelativeShort as formatTime } from '@/lib/date';
import { SpadeConsole } from '../console/SpadeConsole';
import './CashoutRequestModal.css';
import { reportError } from '../../utils/errorReporter';
import { fireVibration } from '../../utils/vibrationGate';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { titleCase } from '../../utils/titleCase';

/**
 * A preset's figure, for its label only. `cashoutPercentage` hands back the
 * exact cent string the field is set to ("125.00"); on the glass a whole
 * amount prints whole ("125", "3,125") and a fractional one keeps its cents
 * ("0.31"). The value sent to the field is unchanged.
 */
const presetFigure = (cents: string): string => {
  const n = Number(cents);
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
// Haptic feedback for mobile-first financial interactions
const triggerHaptic = (pattern: number | number[] = 10) => {
  try {
    // AUDIT 2026-08-20: private copy that called navigator.vibrate directly,
    // so neither vibration switch reached it. Routed through the shared gate.
    fireVibration(pattern);
  } catch (err) {
    reportError(err, 'CashoutRequestModal.Error');
    /* silent */
  }
};

/**
 * THE TEN MINUTE COUNTDOWN THAT USED TO BE HERE WAS THE WRONG WINDOW.
 *
 * This modal rendered "Cancel Window: 9m 41s Remaining" against a pending
 * cashout, on the same screen as its own footer promising "You Can Cancel
 * Anytime Before Approval." Both cannot be true, and the footer is the one that
 * matches the server: fn_cashout_release accepts a player's cancel for as long
 * as the request is pending, with no clock on it at all.
 *
 * The ten minute window is a different rule about different money: an AGENT may
 * undo a send THEY made for ten minutes (fn_agent_wallet_claim_back). Borrowing
 * its constant to decorate a cashout told players their chips were about to
 * become unrecoverable, which was never true.
 */

// ═══════════════════════════════════════════════════════════════════
// CASHOUT STEP PROGRESS TRACKER — Shows cashout lifecycle stage
// ═══════════════════════════════════════════════════════════════════

/**
 * The `icon` field on every step was never rendered - the dot shows a tick or an
 * ordinal, never the emoji - so five astral-plane characters sat in a source
 * file for nothing. CLAUDE.md section 5 rule 3: no emoji in source, it breaks
 * the SWC compiler. Dead AND against the house rule, so both are gone.
 */
const CASHOUT_STEPS = [
  { key: 'requested', label: 'Requested' },
  { key: 'reviewing', label: 'Awaiting Review' },
  { key: 'approved', label: 'Cashout Approved' },
];

function CashoutStepTracker({ status }: { status: string }) {
  // This tracker shows request workflow only. Invoice receipts prove chip movement.
  const stepMap: Record<string, number> = {
    pending: 1, // escrowed, waiting on the agent
    approved: 2, // request workflow; the invoice proves the transfer
    completed: 2, // legacy status; no external payment assertion
    rejected: -1, // declined, chips returned
    cancelled: -1, // withdrawn by the player, chips returned
    expired: -1, // closed request; a legacy status alone does not prove refund
  };
  const currentStep = stepMap[status] ?? 0;
  const isClosed = currentStep === -1;

  /* Printed on the glass, one engraved row per step: the ordinal and the
     label in the master's inks. No dot, no connector line and no tick glyph;
     the ink says where the request stands. */
  return (
    <ol className="cashout-step-tracker">
      {CASHOUT_STEPS.map((step, i) => {
        const isComplete = i < currentStep;
        const isCurrent = i === currentStep;
        const ink = isClosed
          ? 'sc-ink--red'
          : isComplete
            ? 'sc-ink--green'
            : isCurrent
              ? 'sc-ink--gold'
              : 'sc-ink--muted';
        return (
          <li key={step.key} className="cashout-step" aria-current={isCurrent ? 'step' : undefined}>
            <span className={`cro-step-num ${ink}`}>{i + 1}</span>
            <span className={`cro-step-label ${ink}`}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

interface CashoutRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
  clubId: string;
  currentBalance: number | null;
  onComplete?: () => void;
}

export default function CashoutRequestModal(props: CashoutRequestModalProps) {
  const key = useCashoutScopeKey(props.playerId, JSON.stringify([props.clubId, props.isOpen]));
  return <CashoutRequestContent key={key} {...props} />;
}

function CashoutRequestContent({
  isOpen,
  onClose,
  playerId,
  clubId,
  currentBalance,
  onComplete,
}: CashoutRequestModalProps) {
  const balanceAvailable =
    currentBalance !== null && Number.isFinite(currentBalance) && currentBalance >= 0;
  const isCurrent = useCashoutScope(playerId, JSON.stringify([clubId, isOpen]));
  const pendingGeneration = useRef(0);
  const [successText, setSuccessText] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const rowsCurrent = useRef<(() => boolean) | null>(null);
  const rowsScope = useRef<(() => boolean) | null>(null);
  const [pendingCashouts, setPendingCashouts] = useState<CashoutRequest[]>([]);
  const visiblePendingCashouts = rowsScope.current?.() ? pendingCashouts : [];
  const isMounted = useIsMounted();
  const [loadingPending, setLoadingPending] = useState(true);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  /**
   * DOUBLE SUBMIT. `disabled={isSubmitting}` only takes effect after React has
   * rendered; two taps inside one frame - which is what a fast double tap on a
   * phone is - both read the old `false` and both call the RPC. A ref flips
   * synchronously, so the second tap is refused in the same tick.
   */
  const submitLockRef = useRef(false);
  const cancelLockRef = useRef(false);
  const queuedPendingReload = useRef(false);

  /**
   * Declared HERE, above the effects that list it as a dependency. It used to be
   * a plain `const` further down the body: an effect below listing it in its
   * dependency array would have read it during render, before the binding was
   * initialised, and thrown on the temporal dead zone. Hoisting it is what makes
   * the honest dependency array possible.
   */
  const loadPendingCashouts = useCallback(async () => {
    if (!playerId || !clubId || !isCurrent()) return;
    // Defer ordinary refreshes through receipt acknowledgment, never account or
    // dialog retirement. A read started before acceptance still retires old rows.
    if (submitLockRef.current || cancelLockRef.current) {
      queuedPendingReload.current = true;
      return;
    }
    const generation = ++pendingGeneration.current;
    const current = () => isCurrent() && generation === pendingGeneration.current;
    setLoadingPending(true);
    try {
      const cashouts = await cashoutService.getPlayerCashouts(playerId, clubId, 'pending');
      if (current()) {
        rowsCurrent.current = current;
        rowsScope.current = isCurrent;
        setPendingCashouts(cashouts.filter((c) => c.status === 'pending'));
      }
    } catch (err) {
      reportError(err, 'CashoutRequestModal.Failed_to_load_pending_cashouts');
      if (current()) {
        rowsScope.current = isCurrent;
        setPendingCashouts([]);
        setError('Could Not Verify Pending Cashouts. Refresh To Try Again.');
      }
    }
    if (current()) setLoadingPending(false);
  }, [playerId, clubId, isCurrent]);

  const preparedAmount = validateCashoutAmount(amount);
  const requestFormError = !amount
    ? null
    : !preparedAmount.ok
      ? preparedAmount.error
      : !balanceAvailable || currentBalance === null
        ? 'Your Club Balance Is Unavailable. Refresh Before Requesting A Cashout.'
        : preparedAmount.amount > currentBalance
          ? 'That Is More Than Your Available Balance'
          : null;
  const requests = usePreparedCashoutOperations(
    isOpen && preparedAmount.ok
      ? [
          {
            key: 'request',
            intent: {
              userId: playerId,
              playerId,
              clubId,
              targetId: playerId,
              kind: 'cashout_request',
              amount: preparedAmount.amount,
              note,
            },
          },
        ]
      : [],
    isCurrent,
    null
  );
  const cancellations = usePreparedCashoutOperations(
    pendingCashouts.map((row) => ({
      key: row.id,
      intent: {
        userId: playerId,
        receiptViewCurrent: isCurrent,
        playerId: row.playerId,
        clubId: row.clubId,
        targetId: row.id,
        kind: 'cashout_cancel',
        amount: row.amount,
      },
    })),
    rowsCurrent.current,
    pendingCashouts
  );
  const editAmount = (value: string) => {
    requests.invalidate();
    setAmount(value);
  };
  const editNote = (value: string) => {
    requests.invalidate();
    setNote(value);
  };

  // CA-16 BUG FIX: autoCloseTimer had no unmount-guard useEffect. If the parent
  // destroys the modal (route change) while the 2s post-success auto-close
  // countdown is running, setSuccess(false)/onClose fire on an unmounted component.
  useEffect(() => {
    return () => {
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current);
        autoCloseTimer.current = null;
      }
    };
  }, []);

  // ── Focus Trap: trap focus inside modal when open ──
  const handleFocusTrap = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Same rule as the overlay and the X: never leave while chips are in
        // flight. Read from the refs so this callback stays stable.
        if (submitLockRef.current || cancelLockRef.current) return;
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !modalRef.current) return;

      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.addEventListener('keydown', handleFocusTrap);
      // Auto-focus the first focusable element after mount animation
      const t = setTimeout(() => {
        if (modalRef.current) {
          const first = modalRef.current.querySelector<HTMLElement>(
            'input:not([disabled]), button:not([disabled])'
          );
          first?.focus();
        }
      }, 100);
      return () => {
        document.removeEventListener('keydown', handleFocusTrap);
        clearTimeout(t);
        // Restore focus when modal closes
        previousFocusRef.current?.focus();
      };
    }
  }, [isOpen, handleFocusTrap]);

  /**
   * `mounted` used to be set here on a 50ms timer and read by nothing at all -
   * a piece of state, a timer and a render per open, for an entrance animation
   * that is done in CSS by `@keyframes cashoutSheetUp` on .cashout-modal. Gone
   * with its timer; what is left is the reset the effect actually performs.
   */
  useEffect(() => {
    if (!isOpen) {
      // Reset form state so reopening shows fresh form, not stale success/error
      setSuccess(false);
      setError(null);
      setAmount('');
      setNote('');
      // Unknown request identities remain in the durable operation store.
      submitLockRef.current = false;
      cancelLockRef.current = false;
      // Clear auto-close timer if modal is closed externally
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current);
        autoCloseTimer.current = null;
      }
    }
  }, [isOpen]);

  // Load pending cashouts
  useEffect(() => {
    if (isOpen && playerId && clubId) {
      loadPendingCashouts();
    }
  }, [isOpen, playerId, clubId, loadPendingCashouts]);

  // ── Realtime: auto-refresh when cashout status changes (agent approves/rejects) ──
  useEffect(() => {
    if (!isOpen || !playerId) return;

    const channelKey = `cashout-modal-${playerId}`;
    // The returned channel was bound to a `channel` const nobody read. Teardown
    // goes through masterBus.removeRegisteredChannel(channelKey), not the handle.
    masterBus
      .getOrCreateChannel(channelKey)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cashout_requests',
          filter: `player_id=eq.${playerId}`,
        },
        () => {
          loadPendingCashouts();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'CashoutRequestModal._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[CashoutRequestModal] Realtime channel timed out');
        }
      });

    // Bus listener: reload when balance changes
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadPendingCashouts();
      },
      500
    );

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubBalance();
    };
  }, [isOpen, playerId, clubId, loadPendingCashouts]);

  const handleSubmit = async () => {
    if (submitLockRef.current || !isCurrent()) return;
    const validation = validateCashoutAmount(amount);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    const cashoutAmount = validation.amount;
    submitLockRef.current = true;
    setIsSubmitting(true);
    setError(null);
    let start: CashoutStart | null = null;
    try {
      const prepared = requests.get('request', 'cashout_request');
      if (!prepared) throw new Error('Wait For This Cashout Request To Be Verified');
      const accepted = captureCashoutStart(prepared);
      start = accepted;
      const recovery = await recoverCashoutOperation(accepted);
      assertCashoutStartCurrent(start);
      if (!recovery.found) {
        if (!balanceAvailable || currentBalance === null)
          throw new Error('Your Club Balance Is Unavailable. Refresh Before Requesting A Cashout.');
        if (cashoutAmount > currentBalance)
          throw new Error('That Is More Than Your Available Balance');
        const lock = await checkSettlementLock(accepted.clubId);
        assertCashoutStartCurrent(start);
        if (lock.locked) throw new Error('Settlement In Progress. Cashout Requests Are Frozen');
      }
      const result = recovery.found ? recovery.result : await runCashoutOperation(accepted);
      assertCashoutStartCurrent(start);
      setSuccessText(
        result.status === 'pending'
          ? 'Cashout Requested. Chips Are Held For Review. Your Invoice Is Available In Messenger.'
          : `This Cashout Is Already ${titleCase(result.status)}. Check Its Invoice For Details.`
      );
      setSuccess(true);
      setAmount('');
      setNote('');
      triggerHaptic([20, 100, 20]);
      void loadPendingCashouts();
      onComplete?.();
      autoCloseTimer.current = setTimeout(() => {
        if (!isCurrent()) return;
        setSuccess(false);
        onClose();
        autoCloseTimer.current = null;
      }, 2000);
    } catch (err) {
      if (isCurrent() && (!start || isCashoutStartCurrent(start)))
        setError(safeErrorMessage(err, 'Refresh To Check The Cashout Outcome'));
    } finally {
      submitLockRef.current = false;
      if (isCurrent()) {
        setIsSubmitting(false);
        if (!cancelLockRef.current && queuedPendingReload.current) {
          queuedPendingReload.current = false;
          void loadPendingCashouts();
        }
      }
    }
  };

  const receiptChecks = useCashoutReceiptChecks(isCurrent, () => {
    void loadPendingCashouts();
    onComplete?.();
  });

  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const handleCancel = async (cashoutId: string) => {
    if (cancelLockRef.current || !isCurrent() || !rowsCurrent.current?.()) return;
    const cashout = pendingCashouts.find(
      (row) => row.id === cashoutId && row.playerId === playerId
    );
    if (!cashout) {
      setError('Refresh To Verify This Cashout Before Cancelling');
      return;
    }
    cancelLockRef.current = true;
    setCancellingId(cashoutId);
    let start: CashoutStart | null = null;
    let checkingOutcome = false;
    try {
      const prepared = cancellations.get(cashout.id, 'cashout_cancel');
      if (!prepared) throw new Error('Wait For This Cashout Request To Be Verified');
      start = captureCashoutStart(prepared);
      checkingOutcome = true;
      const recovery = await recoverCashoutOperation(start);
      assertCashoutStartCurrent(start);
      if (!recovery.found) await runCashoutOperation(start);
      checkingOutcome = false;
      assertCashoutStartCurrent(start);
      triggerHaptic(15);
      void loadPendingCashouts();
      onComplete?.();
    } catch (err) {
      if (checkingOutcome && start && isCurrent())
        receiptChecks.retain(cashout.id, cashout.amount, 'Cashout Cancellation', start);
      if (isCurrent() && (!start || isCashoutStartCurrent(start))) {
        setSuccess(false);
        setError(safeErrorMessage(err, 'Refresh To Check The Cashout Outcome'));
      }
    } finally {
      cancelLockRef.current = false;
      if (isCurrent()) {
        setCancellingId(null);
        if (!submitLockRef.current && queuedPendingReload.current) {
          queuedPendingReload.current = false;
          void loadPendingCashouts();
        }
      }
    }
  };

  /**
   * Closing the sheet mid-flight does not stop the RPC; it just hides the
   * outcome. The durable operation survives unmount, and ordinary close
   * controls keep the sheet visible while the request is in flight.
   */
  const isBusy = isSubmitting || cancellingId !== null;
  const closeIfIdle = () => {
    if (isBusy) return;
    onClose();
  };

  if (!isOpen) return null;

  /* Held, not spent: chips inside a pending request are escrowed, which is
     what the master's gold ink is for. Only rows this scope has verified
     count; a stale scope's rows are not shown and not counted. */
  const heldCount = visiblePendingCashouts.length;
  const combinedError = error || requests.error || cancellations.error || requestFormError;
  const canRequest = !isSubmitting && !!requests.get('request', 'cashout_request');

  return (
    <div
      className="cro-overlay"
      onClick={closeIfIdle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cashout-modal-title"
    >
      <div className="cashout-modal ac-popup" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <SpadeConsole
          onClose={onClose}
          as="div"
          eyebrow="Chip Cashout"
          title="Request Cashout"
          titleId="cashout-modal-title"
          // The head's pill slot is painted in the master, so the pill is never
          // left empty: the title would run into an unlabelled plate.
          pill={
            heldCount > 0
              ? `${heldCount} Held`
              : success
                ? 'Submitted'
                : combinedError || !balanceAvailable
                  ? 'Attention'
                  : isSubmitting || loadingPending
                    ? 'Checking'
                    : 'Ready'
          }
          pillInk={
            heldCount > 0
              ? 'gold'
              : success
                ? 'green'
                : combinedError || !balanceAvailable
                  ? 'red'
                  : isSubmitting || loadingPending
                    ? 'gold'
                    : 'green'
          }
          plates={{
            secondary: {
              label: 'Close',
              onClick: closeIfIdle,
              disabled: isBusy,
              'aria-label': 'Close Cashout Request',
            },
            primary: success
              ? { label: 'Submitted', ink: 'green', disabled: true }
              : {
                  // The painted face holds twelve characters at its smallest
                  // fit; the full instruction stays the accessible name and
                  // the copy under the form says what the check is.
                  label: isSubmitting ? 'Checking...' : 'Request Cashout',
                  'aria-label': isSubmitting ? 'Checking...' : 'Check Or Request Cashout',
                  ink: canRequest ? 'white' : 'muted',
                  onClick: handleSubmit,
                  disabled: !canRequest,
                },
          }}
        >
          {/* The receipt checks print unstyled markup; this hook types it on
              the glass (display: contents, so it adds no box and no gap). */}
          <div className="cro-receipts">
            <CashoutReceiptChecks checks={receiptChecks} />
          </div>

          {/* The balance every check on this sheet is made against. Exact, and
              never abbreviated: it is the ceiling the request is measured by.
              An unreadable balance says so; it never prints as zero. */}
          <div className="cro-row">
            <span className="sc-label sc-ink--blue">Available Balance</span>
            <strong className={`cro-value ${balanceAvailable ? 'sc-ink--silver' : 'sc-ink--red'}`}>
              {balanceAvailable ? `${currentBalance!.toLocaleString()} Chips` : 'Unavailable'}
            </strong>
          </div>

          {/* LOADING STATE. `loadingPending` was declared, set true, set false,
              and never read once - so on a slow connection the sheet showed a
              form with no sign that a request might already be pending, and the
              row appeared underneath the player's finger a second later. */}
          {(loadingPending || !rowsScope.current?.()) && heldCount === 0 && (
            <div className="cro-block" aria-busy="true">
              <span className="sc-label sc-ink--blue">Pending Requests</span>
              <p className="sc-copy sc-copy--center cro-loading">
                Checking For Pending Requests...
              </p>
            </div>
          )}

          {heldCount === 100 && (
            <p className="sc-copy sc-copy--center cro-note sc-ink--muted">
              Showing The Most Recent 100 Pending Requests.
            </p>
          )}
          {heldCount > 0 && (
            <div className="cro-block">
              <span className="sc-label sc-ink--blue">Pending Requests</span>
              {visiblePendingCashouts.map((cashout) => (
                <div key={cashout.id} className="cro-pending">
                  <div className="cro-row cro-row--plain">
                    <strong className="cro-value sc-ink--gold">
                      {cashout.amount.toLocaleString()} Chips
                    </strong>
                    <span className="cro-when sc-ink--muted">{formatTime(cashout.createdAt)}</span>
                  </div>
                  <CashoutStepTracker status={cashout.status} />
                  <button
                    type="button"
                    className="cro-cancel sc-ink--red"
                    disabled={
                      cancellingId === cashout.id ||
                      !cancellations.get(cashout.id, 'cashout_cancel')
                    }
                    onClick={() => handleCancel(cashout.id)}
                  >
                    {cancellingId === cashout.id ? 'Cancelling...' : 'Cancel'}
                  </button>
                </div>
              ))}
              <p className="sc-copy sc-copy--center cro-note sc-ink--gold">
                These Chips Are Locked Until Your Agent Processes The Request Or You Cancel.
              </p>
            </div>
          )}

          {success ? (
            <p role="status" className="sc-copy sc-copy--center sc-ink--green cro-success">
              {successText}
            </p>
          ) : (
            <div className="cro-form">
              <div className="cro-field">
                <label className="sc-label sc-ink--blue" htmlFor="cashout-amount">
                  Amount
                </label>
                <div className="cro-amount">
                  <input
                    id="cashout-amount"
                    className="cro-input cro-input--amount"
                    type="number"
                    placeholder="0"
                    value={amount}
                    onChange={(e) => editAmount(e.target.value)}
                    disabled={isSubmitting}
                    max={
                      balanceAvailable
                        ? Math.min(currentBalance!, CASHOUT_AMOUNT_LIMIT)
                        : CASHOUT_AMOUNT_LIMIT
                    }
                    min={0.01}
                    step={0.01}
                    inputMode="decimal"
                  />
                  <span className="sc-label sc-ink--muted cro-unit">Chips</span>
                </div>
                {/* Lit numerals on the glass, divided by an engraved rule, not
                    four drawn pills. Each preset says the cent value it will
                    select (cashoutPercentage rounds down at the cent) and is
                    dead when the balance cannot produce one. */}
                <div className="cro-quick" role="group" aria-label="Quick Amounts">
                  {([25, 50, 100] as const).map((pct) => {
                    const selected = cashoutPercentage(currentBalance ?? NaN, pct);
                    return (
                      <button
                        key={pct}
                        type="button"
                        className="cro-preset sc-ink--blue"
                        disabled={isSubmitting || selected === null}
                        onClick={() => {
                          if (selected !== null) editAmount(selected);
                        }}
                      >
                        {pct}%{selected !== null ? ` · ${presetFigure(selected)}` : ''}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="cro-preset sc-ink--blue"
                    disabled={
                      isSubmitting || cashoutPercentage(currentBalance ?? NaN, 100) === null
                    }
                    onClick={() => {
                      const selected = cashoutPercentage(currentBalance ?? NaN, 100);
                      if (selected !== null) editAmount(selected);
                    }}
                  >
                    Max
                    {cashoutPercentage(currentBalance ?? NaN, 100) !== null
                      ? ` · ${presetFigure(cashoutPercentage(currentBalance ?? NaN, 100)!)}`
                      : ''}
                  </button>
                </div>
              </div>

              <div className="cro-field">
                <label className="sc-label sc-ink--blue" htmlFor="cashout-note">
                  Note (Optional)
                </label>
                <textarea
                  id="cashout-note"
                  className="cro-input cro-textarea"
                  placeholder="Any Message For Your Agent..."
                  value={note}
                  onChange={(e) => editNote(e.target.value)}
                  disabled={isSubmitting}
                  rows={2}
                />
              </div>

              {combinedError && (
                <p role="alert" className="sc-copy sc-copy--center sc-ink--red cro-error">
                  {combinedError}
                  {requests.error && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="cro-preset sc-ink--blue"
                        onClick={requests.invalidate}
                      >
                        Refresh
                      </button>
                    </>
                  )}
                </p>
              )}

              <p className="sc-copy sc-copy--center cro-note">
                Your Chips Will Be Locked Until Your Agent Approves The Cashout. You Can Cancel
                Anytime Before Approval.
              </p>
            </div>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}
