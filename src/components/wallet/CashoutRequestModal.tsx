/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHOUT REQUEST MODAL — Player Chip Cashout UI
 * ═══════════════════════════════════════════════════════════════════════════════
 * Modal for players to request chip cashouts from their agent
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { cashoutService, CashoutRequest } from '../../services/CashoutService';
import { masterBus } from '../../core/MasterBus';
import { checkSettlementLock } from '../../utils/settlementLock';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './CashoutRequestModal.css';
import { reportError } from '../../utils/errorReporter';

// Haptic feedback for mobile-first financial interactions
const triggerHaptic = (pattern: number | number[] = 10) => {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  } catch (err) {
    reportError(err, 'CashoutRequestModal.Error');
    /* silent */
  }
};

const REVERSAL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// ═══════════════════════════════════════════════════════════════════
// CASHOUT STEP PROGRESS TRACKER — Shows cashout lifecycle stage
// ═══════════════════════════════════════════════════════════════════

const CASHOUT_STEPS = [
  { key: 'requested', label: 'Requested', icon: '📝' },
  { key: 'escrowed', label: 'Escrow Locked', icon: '🔒' },
  { key: 'reviewing', label: 'Agent Review', icon: '👤' },
  { key: 'sending', label: 'Payment Sent', icon: '💸' },
  { key: 'complete', label: 'Complete', icon: '✅' },
];

function CashoutStepTracker({ status, createdAt }: { status: string; createdAt?: string }) {
  // Map CashoutRequest.status → step index
  const stepMap: Record<string, number> = {
    pending: 1, // escrowed/waiting
    approved: 3, // payment sent
    completed: 4, // done
    rejected: -1, // rejected — show red
  };
  const currentStep = stepMap[status] ?? 0;
  const isRejected = status === 'rejected';

  // 10-minute reversal countdown
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    if (status !== 'pending' || !createdAt) {
      setRemainingMs(null);
      return;
    }
    const tick = () => {
      const elapsed = Date.now() - new Date(createdAt).getTime();
      const remaining = REVERSAL_WINDOW_MS - elapsed;
      setRemainingMs(remaining > 0 ? remaining : null);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status, createdAt]);

  return (
    <>
      <div className="cashout-step-tracker">
        {CASHOUT_STEPS.map((step, i) => {
          const isComplete = i < currentStep;
          const isCurrent = i === currentStep;
          return (
            <div key={step.key} className="cashout-step">
              <div
                className={`step-dot ${isComplete ? 'complete' : ''} ${isCurrent ? 'active' : ''} ${isRejected ? 'rejected' : ''}`}
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
      {remainingMs !== null && remainingMs > 0 && (
        <div
          style={{
            textAlign: 'center',
            fontSize: '0.7rem',
            color: '#ffa726',
            padding: '4px 0 2px',
            fontWeight: 600,
            letterSpacing: '0.3px',
          }}
        >
          ⏱ Cancel window: {Math.floor(remainingMs / 60000)}m{' '}
          {Math.floor((remainingMs % 60000) / 1000)}s remaining
        </div>
      )}
    </>
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
  const [mounted, setMounted] = useState(false);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // ── Focus Trap: trap focus inside modal when open ──
  const handleFocusTrap = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
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
  }, [onClose]);

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

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (isOpen) {
      timer = setTimeout(() => setMounted(true), 50);
    } else {
      setMounted(false);
      // Reset form state so reopening shows fresh form, not stale success/error
      setSuccess(false);
      setError(null);
      setAmount('');
      setNote('');
      // Clear auto-close timer if modal is closed externally
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current);
        autoCloseTimer.current = null;
      }
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isOpen]);

  // Load pending cashouts
  useEffect(() => {
    if (isOpen && playerId && clubId) {
      loadPendingCashouts();
    }
  }, [isOpen, playerId, clubId]);

  // ── Realtime: auto-refresh when cashout status changes (agent approves/rejects) ──
  useEffect(() => {
    if (!isOpen || !playerId) return;

    const channelKey = `cashout-modal-${playerId}`;
    const channel = masterBus
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
          reportError(err?.message || err, 'CashoutRequestModal._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[CashoutRequestModal] ⏱️ Realtime channel timed out');
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
  }, [isOpen, playerId, clubId]);

  const loadPendingCashouts = async () => {
    setLoadingPending(true);
    try {
      const cashouts = await cashoutService.getPlayerCashouts(playerId, clubId);
      if (isMounted.current) setPendingCashouts(cashouts.filter((c) => c.status === 'pending'));
    } catch (err) {
      reportError(err, 'CashoutRequestModal.Failed_to_load_pending_cashouts');
    }
    if (isMounted.current) setLoadingPending(false);
  };

  const handleSubmit = async () => {
    const cashoutAmount = parseFloat(amount);

    if (isNaN(cashoutAmount) || cashoutAmount <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (cashoutAmount > currentBalance) {
      setError('Insufficient balance');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    // SETTLEMENT FREEZE CHECK — block cashout requests during active settlements
    try {
      const lockResult = await checkSettlementLock(clubId);
      if (lockResult.locked) {
        if (isMounted.current) setError('🔒 Settlement in progress — cashout requests frozen');
        if (isMounted.current) setIsSubmitting(false);
        return;
      }
    } catch (e) {
      reportError(e, 'CashoutRequestModal.handleSubmit');
      // Fail-open: allow cashout if settlement check fails
    }

    try {
      await cashoutService.requestCashout(playerId, clubId, cashoutAmount, note || undefined);
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
      if (isMounted.current) setError(err.message || 'Failed to request cashout');
    }
    if (isMounted.current) setIsSubmitting(false);
  };

  const handleCancel = async (cashoutId: string) => {
    try {
      await cashoutService.cancelCashout(cashoutId, playerId);
      triggerHaptic(15);
      loadPendingCashouts();
      onComplete?.();
    } catch (err: any) {
      if (isMounted.current) setError(err.message || 'Failed to cancel cashout');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="cashout-modal-title">
      <div className="cashout-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        {/* Bottom-sheet drag handle */}
        <div className="cashout-drag-handle" />
        <div className="modal-header">
          <h2> Request Cashout</h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Current Balance */}
          <div className="balance-display">
            <span className="label">Available Balance</span>
            <span className="value">{currentBalance.toLocaleString()} chips</span>
          </div>

          {/* Pending Cashouts */}
          {pendingCashouts.length > 0 && (
            <div className="pending-section">
              <h3> Pending Requests</h3>
              <div className="pending-list">
                {pendingCashouts.map((cashout) => (
                  <div key={cashout.id} className="pending-item">
                    <div className="pending-info">
                      <span className="pending-amount">
                        {cashout.amount.toLocaleString()} chips
                      </span>
                      <span className="pending-time">{formatTime(cashout.createdAt)}</span>
                    </div>
                    <CashoutStepTracker status={cashout.status} createdAt={cashout.createdAt} />
                    <button className="cancel-btn" onClick={() => handleCancel(cashout.id)}>
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
              <div className="pending-note">
                These chips are locked until your agent processes the request or you cancel.
              </div>
            </div>
          )}

          {/* New Request Form */}
          {success ? (
            <div className="success-message">
              Cashout request submitted! Your agent has been notified.
            </div>
          ) : (
            <div className="cashout-form">
              <div className="form-group">
                <label>Amount</label>
                <div className="amount-input-wrapper">
                  <input
                    type="number"
                    placeholder="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    max={currentBalance}
                    min={1}
                  />
                  <span className="chip-label">chips</span>
                </div>
                <div className="quick-amounts">
                  {[25, 50, 100].map((pct) => (
                    <button
                      key={pct}
                      className="quick-btn"
                      onClick={() =>
                        setAmount(
                          (Math.trunc(((currentBalance * pct) / 100) * 100) / 100).toString()
                        )
                      }
                    >
                      {pct}%
                    </button>
                  ))}
                  <button
                    className="quick-btn"
                    onClick={() => setAmount(currentBalance.toString())}
                  >
                    Max
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label>Note (optional)</label>
                <textarea
                  placeholder="Any message for your agent..."
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
                {isSubmitting ? 'Submitting...' : ' Request Cashout'}
              </button>

              <div className="info-note">
                Your chips will be locked until your agent approves the cashout. You can cancel
                anytime before approval.
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
