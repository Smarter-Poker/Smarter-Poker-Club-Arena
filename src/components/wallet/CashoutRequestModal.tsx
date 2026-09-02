/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHOUT REQUEST MODAL — Player Chip Cashout UI
 * ═══════════════════════════════════════════════════════════════════════════════
 * Modal for players to request chip cashouts from their agent
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { cashoutService, newOpId, CashoutRequest } from '../../services/CashoutService';
import { masterBus } from '../../core/MasterBus';
import { checkSettlementLock } from '../../utils/settlementLock';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './CashoutRequestModal.css';
import { reportError } from '../../utils/errorReporter';
import { fireVibration } from '../../utils/vibrationGate';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
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
  { key: 'escrowed', label: 'Escrow Locked' },
  { key: 'reviewing', label: 'Agent Review' },
  { key: 'sending', label: 'Payment Sent' },
  { key: 'complete', label: 'Complete' },
];

function CashoutStepTracker({ status }: { status: string }) {
  // Map CashoutRequest.status -> step index. 'expired' is a status the database
  // really writes (fn_expire_stale_cashouts), and it ends the same way a decline
  // does: the chips came back and nothing is in flight.
  const stepMap: Record<string, number> = {
    pending: 1, // escrowed, waiting on the agent
    approved: 3, // released into the agent wallet
    completed: 4, // done
    rejected: -1, // declined, chips returned
    cancelled: -1, // withdrawn by the player, chips returned
    expired: -1, // nobody acted, chips returned
  };
  const currentStep = stepMap[status] ?? 0;
  const isClosed = currentStep === -1;

  return (
    <div className="cashout-step-tracker">
      {CASHOUT_STEPS.map((step, i) => {
        const isComplete = i < currentStep;
        const isCurrent = i === currentStep;
        return (
          <div key={step.key} className="cashout-step">
            <div
              className={`step-dot ${isComplete ? 'complete' : ''} ${isCurrent ? 'active' : ''} ${isClosed ? 'rejected' : ''}`}
            >
              {isComplete ? '✓' : i + 1}
            </div>
            <span
              className={`step-label ${isComplete ? 'complete' : ''} ${isCurrent ? 'active' : ''}`}
            >
              {step.label}
            </span>
            {i < CASHOUT_STEPS.length - 1 && (
              <div className={`step-line ${isComplete ? 'complete' : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface CashoutRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
  clubId: string;
  currentBalance: number;
  onComplete?: () => void;
}

export default function CashoutRequestModal({
  isOpen,
  onClose,
  playerId,
  clubId,
  currentBalance,
  onComplete,
}: CashoutRequestModalProps) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pendingCashouts, setPendingCashouts] = useState<CashoutRequest[]>([]);
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

  /**
   * THE IDEMPOTENCY KEY, AND WHY IT LIVES IN A REF.
   *
   * The service used to mint a fresh op id inside every call, which protects
   * nothing: the dangerous retry is the SECOND call a player makes after their
   * connection dropped mid-request, and a second call carried a second key. One
   * id, minted once, HELD ACROSS A FAILURE and cleared on success, is what makes
   * that retry land on fn_cashout_request's replay branch instead of escrowing
   * the chips twice. Same shape as CashierTradePage's opIdsRef.
   *
   * Cleared whenever the amount or the note changes, because a changed amount is
   * a NEW intent and must not replay the old one.
   */
  const requestOpIdRef = useRef<string | null>(null);
  const cancelOpIdsRef = useRef<Map<string, string>>(new Map());

  /**
   * Declared HERE, above the effects that list it as a dependency. It used to be
   * a plain `const` further down the body: an effect below listing it in its
   * dependency array would have read it during render, before the binding was
   * initialised, and thrown on the temporal dead zone. Hoisting it is what makes
   * the honest dependency array possible.
   */
  const loadPendingCashouts = useCallback(async () => {
    if (!playerId || !clubId) return;
    setLoadingPending(true);
    try {
      const cashouts = await cashoutService.getPlayerCashouts(playerId, clubId);
      if (isMounted.current) setPendingCashouts(cashouts.filter((c) => c.status === 'pending'));
    } catch (err) {
      reportError(err, 'CashoutRequestModal.Failed_to_load_pending_cashouts');
    }
    if (isMounted.current) setLoadingPending(false);
  }, [playerId, clubId, isMounted]);

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
      // A closed modal is a finished intent: the next open must not be able to
      // replay the last one's op id.
      requestOpIdRef.current = null;
      cancelOpIdsRef.current = new Map();
      submitLockRef.current = false;
      cancelLockRef.current = false;
      // Clear auto-close timer if modal is closed externally
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current);
        autoCloseTimer.current = null;
      }
    }
  }, [isOpen]);

  // A changed amount or note is a NEW request, not a retry of the old one.
  useEffect(() => {
    requestOpIdRef.current = null;
  }, [amount, note]);

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
    // Synchronous first, before any await: two taps in one frame both saw
    // isSubmitting === false and both reached the RPC.
    if (submitLockRef.current) return;

    const cashoutAmount = Number(amount);

    if (!Number.isFinite(cashoutAmount) || cashoutAmount <= 0) {
      setError('Enter An Amount Greater Than Zero');
      return;
    }

    // Chip balances are whole chips. A fractional request travelled all the way
    // to Postgres to be refused there, which reads as the app being broken
    // rather than as the number being wrong.
    if (!Number.isInteger(cashoutAmount)) {
      setError('Enter A Whole Number Of Chips');
      return;
    }

    if (cashoutAmount > currentBalance) {
      setError('That Is More Than Your Available Balance');
      return;
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    setError(null);

    // SETTLEMENT FREEZE CHECK — block cashout requests during active settlements
    try {
      const lockResult = await checkSettlementLock(clubId);
      if (lockResult.locked) {
        if (isMounted.current) setError('Settlement In Progress. Cashout Requests Are Frozen');
        submitLockRef.current = false;
        if (isMounted.current) setIsSubmitting(false);
        return;
      }
    } catch (e) {
      reportError(e, 'CashoutRequestModal.handleSubmit');
      // Fail-open: allow cashout if settlement check fails
    }

    // Minted once and HELD if this attempt fails, so the retry replays rather
    // than escrowing a second time.
    if (!requestOpIdRef.current) requestOpIdRef.current = newOpId();

    try {
      await cashoutService.requestCashout(
        playerId,
        clubId,
        cashoutAmount,
        note || undefined,
        requestOpIdRef.current
      );
      // The intent completed: the next request must be a genuinely new one.
      requestOpIdRef.current = null;
      if (!isMounted.current) return;
      setSuccess(true);
      setAmount('');
      setNote('');
      triggerHaptic([20, 100, 20]);
      loadPendingCashouts();
      onComplete?.();

      // Auto-close after 2 seconds (with cleanup)
      autoCloseTimer.current = setTimeout(() => {
        setSuccess(false);
        onClose();
        autoCloseTimer.current = null;
      }, 2000);
    } catch (err: any) {
      // requestOpIdRef is DELIBERATELY not cleared here. A failure is exactly
      // the case where the request may in fact have committed and only the
      // response was lost, so the next attempt has to carry the same key.
      if (isMounted.current) setError(safeErrorMessage(err, 'Failed to request cashout'));
    }
    submitLockRef.current = false;
    if (isMounted.current) setIsSubmitting(false);
  };

  // Tracks the cashout currently being cancelled. Without it a double tap on
  // mobile fired two cancel-my-cashout calls for the same request.
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = async (cashoutId: string) => {
    // The `cancellingId` state check alone lost the same race handleSubmit did.
    if (cancelLockRef.current) return;
    cancelLockRef.current = true;
    setCancellingId(cashoutId);

    let opId = cancelOpIdsRef.current.get(cashoutId);
    if (!opId) {
      opId = newOpId();
      cancelOpIdsRef.current.set(cashoutId, opId);
    }

    try {
      await cashoutService.cancelCashout(cashoutId, playerId, opId);
      cancelOpIdsRef.current.delete(cashoutId);
      triggerHaptic(15);
      loadPendingCashouts();
      onComplete?.();
    } catch (err: any) {
      // The op id stays in the map on purpose, for the same reason handleSubmit
      // keeps its own: a retry must replay, not refund a second time.
      //
      // The inline error element only renders inside the `!success` branch, so
      // after a successful request a later cancel failure was invisible.
      // Clearing `success` puts the form back on screen with the error on it.
      const msg = safeErrorMessage(err, 'Failed to cancel cashout');
      if (isMounted.current) {
        setSuccess(false);
        setError(msg);
      }
    } finally {
      cancelLockRef.current = false;
      if (isMounted.current) setCancellingId(null);
    }
  };

  /**
   * Closing the sheet mid-flight does not stop the RPC; it just hides the
   * outcome, and the unmount cleanup then drops the op id that would have made
   * the retry safe. So while chips are moving, the sheet stays put.
   */
  const isBusy = isSubmitting || cancellingId !== null;
  const closeIfIdle = () => {
    if (isBusy) return;
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      onClick={closeIfIdle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cashout-modal-title"
    >
      <div className="cashout-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        {/* Bottom-sheet drag handle */}
        <div className="cashout-drag-handle" />
        <div className="modal-header">
          {/* id added: aria-labelledby="cashout-modal-title" pointed at nothing */}
          <h2 id="cashout-modal-title">Request Cashout</h2>
          <button className="close-btn" onClick={closeIfIdle} disabled={isBusy}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Current Balance */}
          <div className="balance-display">
            <span className="label">Available Balance</span>
            <span className="value">{currentBalance.toLocaleString()} Chips</span>
          </div>

          {/* LOADING STATE. `loadingPending` was declared, set true, set false,
              and never read once - so on a slow connection the sheet showed a
              form with no sign that a request might already be pending, and the
              row appeared underneath the player's finger a second later. */}
          {loadingPending && pendingCashouts.length === 0 && (
            <div className="pending-section" aria-busy="true">
              <h3>Pending Requests</h3>
              <div className="pending-loading">Checking For Pending Requests...</div>
            </div>
          )}

          {/* Pending Cashouts */}
          {pendingCashouts.length > 0 && (
            <div className="pending-section">
              <h3>Pending Requests</h3>
              <div className="pending-list">
                {pendingCashouts.map((cashout) => (
                  <div key={cashout.id} className="pending-item">
                    <div className="pending-info">
                      <span className="pending-amount">
                        {cashout.amount.toLocaleString()} Chips
                      </span>
                      <span className="pending-time">{formatTime(cashout.createdAt)}</span>
                    </div>
                    <CashoutStepTracker status={cashout.status} />
                    <button
                      type="button"
                      className="cancel-btn"
                      disabled={cancellingId === cashout.id}
                      onClick={() => handleCancel(cashout.id)}
                    >
                      {cancellingId === cashout.id ? 'Cancelling...' : 'Cancel'}
                    </button>
                  </div>
                ))}
              </div>
              <div className="pending-note">
                These Chips Are Locked Until Your Agent Processes The Request Or You Cancel.
              </div>
            </div>
          )}

          {/* New Request Form */}
          {success ? (
            <div className="success-message">
              Cashout Request Submitted! Your Agent Has Been Notified.
            </div>
          ) : (
            <div className="cashout-form">
              <div className="form-group">
                <label htmlFor="cashout-amount">Amount</label>
                <div className="amount-input-wrapper">
                  <input
                    id="cashout-amount"
                    type="number"
                    placeholder="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    max={currentBalance}
                    min={1}
                    step={1}
                    inputMode="numeric"
                  />
                  <span className="chip-label">Chips</span>
                </div>
                <div className="quick-amounts">
                  {[25, 50, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      className="quick-btn"
                      // Math.floor, not a 2-decimal truncation: chips are held
                      // in an INTEGER column and the server rejects fractional
                      // amounts outright, so "25%" of 1,234 used to produce
                      // 308.5 and a guaranteed rejection.
                      onClick={() => setAmount(String(Math.floor((currentBalance * pct) / 100)))}
                    >
                      {pct}%
                    </button>
                  ))}
                  <button
                    type="button"
                    className="quick-btn"
                    onClick={() => setAmount(String(Math.floor(currentBalance)))}
                  >
                    Max
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="cashout-note">Note (Optional)</label>
                <textarea
                  id="cashout-note"
                  placeholder="Any Message For Your Agent..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                />
              </div>

              {error && <div className="error-message">{error}</div>}

              <button
                className="submit-btn"
                onClick={handleSubmit}
                disabled={isSubmitting || !amount}
              >
                {isSubmitting ? 'Submitting...' : 'Request Cashout'}
              </button>

              <div className="info-note">
                Your Chips Will Be Locked Until Your Agent Approves The Cashout. You Can Cancel
                Anytime Before Approval.
              </div>
            </div>
          )}
        </div>
        {/* Bottom safe area spacer */}
        <div className="cashout-bottom-spacer" />
      </div>
    </div>
  );
}
