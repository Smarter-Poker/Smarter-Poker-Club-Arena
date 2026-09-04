/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPOSIT/WITHDRAW MODAL — Premium Financial Engine (Q2 Upgrade)
 * Method icon, step progress indicator, celebration animations
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import styles from './DepositWithdrawModal.module.css';
import { reportError } from '../../utils/errorReporter';
import { fireVibration } from '../../utils/vibrationGate';

// Haptic feedback utility for mobile-first financial interactions
const triggerHaptic = (pattern: number | number[] = 10) => {
  try {
    // AUDIT 2026-08-20: private copy that called navigator.vibrate directly,
    // so neither vibration switch reached it. Routed through the shared gate.
    fireVibration(pattern);
  } catch (err) {
    reportError(err, 'DepositWithdrawModal.Error');
    /* silent — not all devices support vibration */
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type Mode = 'deposit' | 'withdraw';

/**
 * NAMED CASH-OUT BRANDS ARE GONE. Dan, 2026-09-04.
 *
 * This union carried four named third-party cash-out brands beside `agent`, and
 * the catalog below published a Club Arena account handle for each of them.
 * Dan, verbatim: "PLAYERS CAN CASH OUT THEIR CHIPS WITH AN AGENT FOR REAL WORLD
 * PRIZES, SMARTER.POKER NEVER RECEIVES PAYOUTS OR TAKES PAYMENT DIRECTLY FOR
 * ANY CLUB ARENA PLAY." Publishing a payment handle in the platform's own name
 * said the opposite. The names are not recorded here on purpose; they are not
 * to be in this codebase.
 *
 * ONLY THE NAMES WERE REMOVED. The sheet's flow, steps, limits, fee maths,
 * validation and the FUNDING_ENDPOINT seam are all exactly as they were.
 * Do not add a brand back to this union.
 */
type PaymentMethod = 'agent';

interface DepositWithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: Mode;
  userId: string;
  currentBalance: number;
  onComplete?: () => void;
}

interface PaymentMethodInfo {
  id: PaymentMethod;
  icon: string;
  label: string;
  description: string;
  minAmount: number;
  maxAmount: number;
  fee: number; // percentage
  processingTime: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// METHOD ICON
// ═══════════════════════════════════════════════════════════════════════════════

/* Four third-party brand marks stood beside the agent one. Removed with the
   names; the component and the agent mark are unchanged. */
const PaymentLogo = ({ method }: { method: PaymentMethod }) => {
  const size = 32;
  const logos: Record<PaymentMethod, React.ReactNode> = {
    agent: (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="14" fill="#1a73e8" />
        <circle cx="16" cy="12" r="5" fill="white" />
        <path d="M8 26c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="white" />
      </svg>
    ),
  };
  return logos[method] || null;
};

// Step progress indicator
const StepProgress = ({ current }: { current: 'method' | 'amount' | 'confirm' | 'success' }) => {
  const steps = ['method', 'amount', 'confirm', 'success'];
  const currentIdx = steps.indexOf(current);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        padding: '12px 24px 0',
      }}
    >
      {steps.map((s, i) => (
        <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <div
            style={{
              width: i <= currentIdx ? '24px' : '8px',
              height: '4px',
              borderRadius: '2px',
              background:
                i <= currentIdx
                  ? i === currentIdx && current === 'success'
                    ? '#00C853'
                    : '#fbbf24'
                  : 'rgba(255,255,255,0.1)',
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
        </div>
      ))}
    </div>
  );
};

/**
 * The server route that would accept a funding request. `null` means there is
 * none — see the block comment on handleConfirm for the four separate reasons
 * the old direct `wallet_transactions` insert could never work, and why it must
 * not simply be repaired into working. Set this to the route path once it
 * exists and the POST below starts carrying real requests.
 */
const FUNDING_ENDPOINT: string | null = null;

const PAYMENT_METHODS: PaymentMethodInfo[] = [
  {
    id: 'agent',
    icon: '',
    label: 'Agent',
    description: 'Transfer Through Your Agent',
    minAmount: 10,
    maxAmount: 50000,
    fee: 0,
    processingTime: 'Instant',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DepositWithdrawModal({
  isOpen,
  onClose,
  mode,
  userId,
  currentBalance,
  onComplete,
}: DepositWithdrawModalProps) {
  const toast = useToast();
  const [step, setStep] = useState<'method' | 'amount' | 'confirm' | 'success'>('method');
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | null>(null);
  const [amount, setAmount] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const isMounted = useIsMounted();
  const mountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Withdrawal-specific fields
  const [withdrawAddress, setWithdrawAddress] = useState('');

  useEffect(() => {
    if (isOpen) {
      mountTimer.current = setTimeout(() => setMounted(true), 50);
    } else {
      setMounted(false);
    }
    return () => {
      if (mountTimer.current) clearTimeout(mountTimer.current);
    };
  }, [isOpen]);

  // ── Close handler: resets all form state and calls parent onClose ──
  const handleClose = useCallback(() => {
    setStep('method');
    setSelectedMethod(null);
    setAmount('');
    setError(null);
    setReferenceId(null);
    setWithdrawAddress('');
    onClose();
  }, [onClose]);

  // ── Focus Trap: trap focus inside modal when open ──
  const handleFocusTrap = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
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
    [handleClose]
  );

  /* THE EFFECT BELOW MUST DEPEND ON `isOpen` AND NOTHING ELSE.
     It used to list `handleFocusTrap`, which is a useCallback on `handleClose`,
     which is a useCallback on the `onClose` PROP — and PlayerWalletPage passes
     `onClose={() => setShowDepositModal(false)}`, a fresh arrow on every one of
     its renders. That page also runs three `useAnimatedNumber` counters, so it
     re-renders at 60fps whenever a balance moves. The effect therefore tore
     itself down and rebuilt sixty times a second while the sheet was open:
     the keydown listener was churned, the 100ms autofocus timer was cancelled
     and restarted before it could ever fire (so the sheet never focused
     anything), and the cleanup's `previousFocusRef.current?.focus()` ran on
     every one of those passes — pulling focus back out of the modal, from
     inside an open modal, while the user was typing an amount into it.

     The handler goes in a ref instead: one stable listener for the life of the
     open sheet, one restore of focus when it actually closes. */
  const focusTrapRef = useRef(handleFocusTrap);
  useEffect(() => {
    focusTrapRef.current = handleFocusTrap;
  }, [handleFocusTrap]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement;
    const onKeyDown = (e: KeyboardEvent) => focusTrapRef.current(e);
    document.addEventListener('keydown', onKeyDown);
    const t = setTimeout(() => {
      if (modalRef.current) {
        const first = modalRef.current.querySelector<HTMLElement>(
          'button:not([disabled]), input:not([disabled])'
        );
        first?.focus();
      }
    }, 100);
    /* The page behind a bottom sheet must not scroll under it. Every other
       modal in the wallet family does this (PlayerWalletModal locks it on the
       same `isOpen`); this one did not, so dragging the sheet on a phone
       scrolled the wallet page underneath and left the sheet floating over a
       different part of the document. */
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  const currentMethod = PAYMENT_METHODS.find((m) => m.id === selectedMethod);
  const parsed = parseFloat(amount);
  const numericAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  // Use integer math to avoid floating-point precision errors:
  // fee = round((amount_cents * fee_percent) / 100) / 100
  const feeAmount = currentMethod ? Math.round(numericAmount * currentMethod.fee) / 100 : 0;
  /* `totalAmount` used to be computed here and never read once. It was also
     WRONG: it said a withdrawal costs `amount + fee`, while the confirm screen
     below says you receive `amount - fee` and the balance check compares the
     bare `amount`. Two contradictory fee models in one component, with the
     unused one quietly waiting for somebody to render it. Deleted rather than
     reconciled - the confirm screen and the balance check already agree with
     each other, and they are the two the player actually sees. */

  const handleMethodSelect = (method: PaymentMethod) => {
    triggerHaptic(10);
    setSelectedMethod(method);
    setStep('amount');
    setError(null);
  };

  const handleAmountSubmit = () => {
    if (!currentMethod) return;

    // Casing: Dan's popup law is about what the player reads, not about which
    // component renders it. These four are in-page messages, so the Toast
    // layer's formatPopupText never reached them and they alone on this screen
    // were in sentence case.
    if (numericAmount < currentMethod.minAmount) {
      setError(`Minimum Amount Is ${currentMethod.minAmount.toLocaleString()}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    if (numericAmount > currentMethod.maxAmount) {
      setError(`Maximum Amount Is ${currentMethod.maxAmount.toLocaleString()}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    if (mode === 'withdraw' && numericAmount > currentBalance) {
      setError(`Insufficient Balance. Available: ${currentBalance.toLocaleString()}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    // Require withdrawal destination for non-agent methods
    if (mode === 'withdraw' && selectedMethod !== 'agent' && !withdrawAddress.trim()) {
      setError('Please Enter A Withdrawal Destination');
      triggerHaptic([30, 50, 30]);
      return;
    }

    triggerHaptic(15);
    setStep('confirm');
    setError(null);
  };

  /**
   * ══ THE CONFIRM STEP COULD NOT SUCCEED. AUDIT 2026-08-25. ══════════════════
   *
   * It inserted into `wallet_transactions` and that insert was impossible in
   * FOUR independent ways, every one of them verified against production:
   *
   *  1. RLS. `wallet_transactions` carries exactly one policy — "Users view own
   *     transactions", cmd SELECT. There is no INSERT policy for `public` or
   *     `authenticated`, so the write returned 42501 every single time. This is
   *     the same control WalletService.logTransaction documents at length: the
   *     browser is deliberately not allowed to forge ledger rows, and "the
   *     denial is the control working".
   *  2. FOUR COLUMNS THAT DO NOT EXIST. It set `fee`, `payment_method`,
   *     `status` and `metadata`. The table has none of them — its columns are
   *     id, user_id, wallet_type, amount, type, category, description,
   *     related_entity_id, table_id, hand_id, created_at, balance_after.
   *  3. A CHECK VIOLATION. `type` was set to 'deposit' / 'withdraw';
   *     `wallet_transactions_type_check` admits only 'credit' and 'debit'.
   *  4. NO CATEGORY. The row carried none, and the category check has no
   *     default that fits a pending request.
   *
   * So both hero buttons on the Player Wallet page have been a guaranteed
   * failure toast plus one Sentry report per click, for as long as this code
   * has existed.
   *
   * AND IT SHOULD NOT BE REPAIRED INTO WORKING. `wallet_transactions` is the
   * SETTLED ledger — TransactionHistory, three lines up the same page, reads
   * it. A pending deposit written there would render to the player as a
   * completed credit for money that has not arrived, above a running balance it
   * did not change. There is no client-writable table for a funding REQUEST
   * either: `chip_requests` holds one row in all of production, and there is no
   * /api/club-arena/ route for deposits or withdrawals.
   *
   * So the modal stops pretending. It says plainly that the channel is not
   * open and sends the player to the agent, which is the real chip path in this
   * product. The seam for the server route is one constant below: give
   * FUNDING_ENDPOINT a URL and restore the POST, exactly as
   * WalletService.mintChips does against /api/club-arena/mint-chips.
   */
  const handleConfirm = async () => {
    if (!currentMethod) return;
    // Double-submit guard: if already processing, ignore subsequent clicks
    if (processing) return;

    if (!FUNDING_ENDPOINT) {
      // Not an exception: nothing failed, the feature has no server side. A
      // reportError here would file a bug report on every click of a button we
      // already know about, which is the noise the logTransaction audit
      // removed from this codebase in the first place.
      setError(
        mode === 'deposit'
          ? 'Deposits Are Not Open On This Channel Yet. Ask Your Agent To Send You Chips'
          : 'Withdrawals Are Not Open On This Channel Yet. Ask Your Agent To Cash You Out'
      );
      triggerHaptic([30, 50, 30]);
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Authentication required');

      const resp = await fetch(FUNDING_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          userId,
          mode,
          amount: numericAmount,
          fee: feeAmount,
          method: selectedMethod,
          destination: mode === 'withdraw' ? withdrawAddress : null,
        }),
      });
      const result = await resp
        .json()
        .catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
      if (!result.success) throw new Error(result.error || `HTTP ${resp.status}`);

      if (!isMounted.current) return;
      setReferenceId(result.referenceId ?? null);
      setStep('success');
      triggerHaptic([20, 100, 20]);
      onComplete?.();
      // Emit bus event so DynamicWallet and other components refresh balances
      masterBus.emit('BALANCE_UPDATED', { source: mode, amount: numericAmount });
    } catch (err) {
      reportError(err, 'DepositWithdrawModal.mode_failed');
      if (isMounted.current) {
        const msg =
          mode === 'deposit'
            ? 'Could Not Start That Deposit. Please Try Again'
            : 'Could Not Start That Withdrawal. Please Try Again';
        toast.error(msg);
        setError(msg);
      }
    }
    if (isMounted.current) setProcessing(false);
  };

  const quickAmounts = [25, 50, 100, 250, 500, 1000];

  if (!isOpen) return null;

  return (
    <div
      className={styles.overlay}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-withdraw-modal-title"
    >
      <div
        className={styles.modal}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          animation: mounted ? 'sheetSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards' : 'none',
          transform: mounted ? undefined : 'translateY(100%)',
        }}
      >
        {/* Bottom-sheet drag handle */}
        <div className={styles.dragHandle} />
        {/* Header */}
        <div className={styles.header}>
          <h2>{mode === 'deposit' ? 'Deposit Funds' : 'Withdraw Funds'}</h2>
          {step !== 'method' && step !== 'success' && (
            <button
              className={styles.backBtn}
              onClick={() => setStep(step === 'confirm' ? 'amount' : 'method')}
            >
              ← Back
            </button>
          )}
          <button className={styles.closeBtn} onClick={handleClose}>
            ✕
          </button>
        </div>

        {/* Step Progress Indicator */}
        <StepProgress current={step} />

        {/* Current Balance */}
        <div className={styles.balanceBar}>
          <span>Current Balance</span>
          <span className={styles.balanceValue}>{currentBalance.toLocaleString()}</span>
        </div>

        {/* Error */}
        {error && <div className={styles.error}>{error}</div>}

        {/* Step 1: Select Method */}
        {step === 'method' && (
          <div className={styles.methodGrid}>
            {PAYMENT_METHODS.map((method) => (
              <button
                key={method.id}
                className={styles.methodCard}
                onClick={() => handleMethodSelect(method.id)}
              >
                <PaymentLogo method={method.id} />
                <span className={styles.methodLabel}>{method.label}</span>
                <span className={styles.methodDesc}>{method.description}</span>
                <span className={styles.methodFee}>
                  {method.fee > 0 ? `${method.fee}% Fee` : 'No Fee'}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Enter Amount */}
        {step === 'amount' && currentMethod && (
          <div className={styles.amountSection}>
            <div className={styles.selectedMethod}>
              <span>
                {currentMethod.icon} {currentMethod.label}
              </span>
              <span className={styles.processingTime}> {currentMethod.processingTime}</span>
            </div>

            <div className={styles.amountInput}>
              <input
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </div>

            <div className={styles.quickAmounts}>
              {quickAmounts.map((qa) => (
                <button
                  key={qa}
                  onClick={() => setAmount(qa.toString())}
                  className={numericAmount === qa ? styles.active : ''}
                  style={qa === 500 ? { position: 'relative' } : undefined}
                >
                  {qa.toLocaleString()}
                  {qa === 500 && (
                    <span
                      style={{
                        position: 'absolute',
                        top: '-8px',
                        right: '-4px',
                        fontSize: '8px',
                        background: '#00C853',
                        color: '#fff',
                        padding: '1px 5px',
                        borderRadius: '6px',
                        fontWeight: 700,
                        letterSpacing: '0.3px',
                        lineHeight: '1.4',
                      }}
                    >
                      BEST
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* A WITHDRAWAL'S REAL CEILING IS THE BALANCE.
                This showed the METHOD's limit for both directions, so a player
                with 300 chips reading "Max: 100,000" typed 5,000, pressed
                Continue, and only then learned they had 300 — the balance check
                is in handleAmountSubmit, one screen later. Stating the binding
                limit is not a new rule, it is the rule that was already being
                enforced, moved to where it can be read before it bites. */}
            <div className={styles.limits}>
              <span>Min: {currentMethod.minAmount.toLocaleString()}</span>
              <span>
                Max:{' '}
                {(mode === 'withdraw'
                  ? Math.min(currentMethod.maxAmount, Math.max(0, currentBalance))
                  : currentMethod.maxAmount
                ).toLocaleString()}
              </span>
            </div>

            {mode === 'withdraw' && (
              <div className={styles.addressInput}>
                {/* A five-branch ternary picked a destination label per brand
                    here. Only the agent branch has a name left to show. */}
                <label>Agent ID</label>
                <input
                  type="text"
                  placeholder="Enter Destination..."
                  value={withdrawAddress}
                  onChange={(e) => setWithdrawAddress(e.target.value)}
                />
              </div>
            )}

            <button
              className={styles.continueBtn}
              onClick={handleAmountSubmit}
              disabled={numericAmount <= 0}
            >
              Continue
            </button>
          </div>
        )}

        {/* Step 3: Confirm */}
        {step === 'confirm' && currentMethod && (
          <div className={styles.confirmSection}>
            <div className={styles.summary}>
              <div className={styles.summaryRow}>
                <span>Amount</span>
                <span>{numericAmount.toLocaleString()}</span>
              </div>
              {feeAmount > 0 && (
                <div className={styles.summaryRow}>
                  <span>Fee ({currentMethod.fee}%)</span>
                  <span>
                    -
                    {feeAmount.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              )}
              <div className={`${styles.summaryRow} ${styles.total}`}>
                <span>{mode === 'deposit' ? 'You Pay' : 'You Receive'}</span>
                <span>
                  {mode === 'deposit'
                    ? numericAmount.toLocaleString()
                    : (Math.round((numericAmount - feeAmount) * 100) / 100).toLocaleString(
                        undefined,
                        { minimumFractionDigits: 2, maximumFractionDigits: 2 }
                      )}
                </span>
              </div>
            </div>

            <div className={styles.methodInfo}>
              <span className={styles.methodIcon}>{currentMethod.icon}</span>
              <span>{currentMethod.label}</span>
              <span className={styles.processingTime}> {currentMethod.processingTime}</span>
            </div>

            {mode === 'deposit' && (
              <div className={styles.instructions}>
                <p>After Clicking Confirm:</p>
                <ol>
                  <li>
                    Send {numericAmount.toLocaleString()} To{' '}
                    <strong>{currentMethod.description}</strong>
                  </li>
                  <li>Include Your Reference ID In The Memo</li>
                  <li>Funds Will Be Credited Within {currentMethod.processingTime}</li>
                </ol>
              </div>
            )}

            {/* Say it BEFORE the button, not after the click. Leading someone
                through three steps of a money flow and only then telling them
                the channel does not exist is the same discourtesy as the old
                generic "Please try again" - it just costs them more time
                first. */}
            {!FUNDING_ENDPOINT && (
              <div className={styles.error}>
                {mode === 'deposit'
                  ? 'Deposits Are Not Open On This Channel Yet. Ask Your Agent To Send You Chips'
                  : 'Withdrawals Are Not Open On This Channel Yet. Ask Your Agent To Cash You Out'}
              </div>
            )}

            <button
              className={styles.confirmBtn}
              onClick={handleConfirm}
              disabled={processing || !FUNDING_ENDPOINT}
            >
              {processing
                ? 'Processing...'
                : `Confirm ${mode === 'deposit' ? 'Deposit' : 'Withdrawal'}`}
            </button>
          </div>
        )}

        {/* Step 4: Success */}
        {step === 'success' && (
          <div className={styles.successSection}>
            {/* Animated checkmark */}
            <div
              style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #00C853, #69F0AE)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 8px 32px rgba(0, 200, 83, 0.3)',
                animation: 'animationsSuccessIconPulse 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)',
              }}
            >
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3>{mode === 'deposit' ? 'Deposit Initiated!' : 'Withdrawal Submitted!'}</h3>

            {mode === 'deposit' && (
              <>
                <p>
                  Send Exactly <strong>{numericAmount.toLocaleString()}</strong> To:
                </p>
                <div className={styles.paymentDetails}>
                  <span className={styles.destination}>{currentMethod?.description}</span>
                </div>
                <div className={styles.referenceBox}>
                  <span className={styles.refLabel}>Reference ID</span>
                  <span className={styles.refValue}>{referenceId?.slice(0, 8).toUpperCase()}</span>
                </div>
                <p className={styles.hint}>Include This ID In Your Payment Memo</p>
              </>
            )}

            {mode === 'withdraw' && (
              <p style={{ color: 'rgba(255,255,255,0.6)' }}>
                Your Withdrawal Is Being Processed. You'll Receive Confirmation Soon.
              </p>
            )}

            <button className={styles.doneBtn} onClick={handleClose}>
              Done
            </button>
          </div>
        )}
        {/* Bottom safe area spacer */}
        <div className={styles.bottomSpacer} />
      </div>
    </div>
  );
}
