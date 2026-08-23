/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPOSIT/WITHDRAW MODAL — Premium Financial Engine (Q2 Upgrade)
 * Branded payment logos, step progress indicator, celebration animations
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
type PaymentMethod = 'crypto' | 'venmo' | 'zelle' | 'cashapp' | 'agent';

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
// BRANDED SVG LOGOS — High-trust payment method icons
// ═══════════════════════════════════════════════════════════════════════════════

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
    crypto: (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="14" fill="#f7931a" />
        <text
          x="16"
          y="21"
          textAnchor="middle"
          fill="white"
          fontSize="16"
          fontWeight="bold"
          fontFamily="Arial"
        >
          ₿
        </text>
      </svg>
    ),
    venmo: (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#008CFF" />
        <text
          x="16"
          y="22"
          textAnchor="middle"
          fill="white"
          fontSize="18"
          fontWeight="bold"
          fontFamily="Arial"
        >
          V
        </text>
      </svg>
    ),
    zelle: (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#6c1cd3" />
        <text
          x="16"
          y="22"
          textAnchor="middle"
          fill="white"
          fontSize="18"
          fontWeight="bold"
          fontFamily="Arial"
        >
          Z
        </text>
      </svg>
    ),
    cashapp: (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#00D632" />
        <text
          x="16"
          y="22"
          textAnchor="middle"
          fill="white"
          fontSize="18"
          fontWeight="bold"
          fontFamily="Arial"
        >
          $
        </text>
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

const PAYMENT_METHODS: PaymentMethodInfo[] = [
  {
    id: 'agent',
    icon: '',
    label: 'Agent',
    description: 'Transfer through your agent',
    minAmount: 10,
    maxAmount: 50000,
    fee: 0,
    processingTime: 'Instant',
  },
  {
    id: 'crypto',
    icon: '₿',
    label: 'Crypto',
    description: 'BTC, ETH, USDT',
    minAmount: 20,
    maxAmount: 100000,
    fee: 0,
    processingTime: '10-30 min',
  },
  {
    id: 'venmo',
    icon: 'V',
    label: 'Venmo',
    description: '@ClubArena',
    minAmount: 10,
    maxAmount: 5000,
    fee: 3,
    processingTime: '1-2 hours',
  },
  {
    id: 'zelle',
    icon: 'Z',
    label: 'Zelle',
    description: 'pay@clubarena.com',
    minAmount: 10,
    maxAmount: 10000,
    fee: 2,
    processingTime: '1-2 hours',
  },
  {
    id: 'cashapp',
    icon: '$',
    label: 'Cash App',
    description: '$ClubArena',
    minAmount: 10,
    maxAmount: 5000,
    fee: 3,
    processingTime: '1-2 hours',
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

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.addEventListener('keydown', handleFocusTrap);
      const t = setTimeout(() => {
        if (modalRef.current) {
          const first = modalRef.current.querySelector<HTMLElement>(
            'button:not([disabled]), input:not([disabled])'
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

  const currentMethod = PAYMENT_METHODS.find((m) => m.id === selectedMethod);
  const numericAmount = parseFloat(amount) || 0;
  // Use integer math to avoid floating-point precision errors:
  // fee = round((amount_cents * fee_percent) / 100) / 100
  const feeAmount = currentMethod ? Math.round(numericAmount * currentMethod.fee) / 100 : 0;
  const totalAmount = mode === 'deposit' ? numericAmount : numericAmount + feeAmount;

  const handleMethodSelect = (method: PaymentMethod) => {
    triggerHaptic(10);
    setSelectedMethod(method);
    setStep('amount');
    setError(null);
  };

  const handleAmountSubmit = () => {
    if (!currentMethod) return;

    if (numericAmount < currentMethod.minAmount) {
      setError(`Minimum amount is ${currentMethod.minAmount}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    if (numericAmount > currentMethod.maxAmount) {
      setError(`Maximum amount is ${currentMethod.maxAmount.toLocaleString()}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    if (mode === 'withdraw' && numericAmount > currentBalance) {
      setError('Insufficient balance');
      triggerHaptic([30, 50, 30]);
      return;
    }
    // Require withdrawal destination for non-agent methods
    if (mode === 'withdraw' && selectedMethod !== 'agent' && !withdrawAddress.trim()) {
      setError('Please enter a withdrawal destination');
      triggerHaptic([30, 50, 30]);
      return;
    }

    triggerHaptic(15);
    setStep('confirm');
    setError(null);
  };

  const handleConfirm = async () => {
    if (!currentMethod) return;
    // Double-submit guard: if already processing, ignore subsequent clicks
    if (processing) return;

    setProcessing(true);
    setError(null);

    try {
      // Create transaction record
      const { data, error: txError } = await supabase
        .from('wallet_transactions')
        .insert({
          user_id: userId,
          type: mode,
          amount: numericAmount,
          fee: feeAmount,
          payment_method: selectedMethod,
          status: mode === 'deposit' ? 'pending' : 'processing',
          wallet_type: 'PLAYER',
          metadata: {
            withdraw_address: mode === 'withdraw' ? withdrawAddress : null,
          },
        })
        .select()
        .maybeSingle();

      if (txError) throw txError;

      // NOTE: a per-wallet withdrawal lock was removed here — it wrote a
      // non-existent `wallets.locked_until` column and `wallets` is
      // service-role-write-only, so the update always failed silently (0 rows)
      // and the lock never engaged. A real concurrency lock must be enforced
      // server-side (SECURITY DEFINER RPC) if needed; the previous code was
      // dead financial-safety theater.

      if (!isMounted.current) return;
      setReferenceId(data?.id ?? null);
      setStep('success');
      triggerHaptic([20, 100, 20]);
      onComplete?.();
      // Emit bus event so DynamicWallet and other components refresh balances
      masterBus.emit('BALANCE_UPDATED', { source: mode, amount: numericAmount });
    } catch (err) {
      reportError(err, 'DepositWithdrawModal.mode_failed');
      if (isMounted.current) {
        toast.error(`Failed to process ${mode}. Please try again.`);
        setError(`Failed to process ${mode}. Please try again.`);
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
                  {method.fee > 0 ? `${method.fee}% fee` : 'No fee'}
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

            <div className={styles.limits}>
              <span>Min: {currentMethod.minAmount}</span>
              <span>Max: {currentMethod.maxAmount.toLocaleString()}</span>
            </div>

            {mode === 'withdraw' && (
              <div className={styles.addressInput}>
                <label>
                  {selectedMethod === 'crypto'
                    ? 'Wallet Address'
                    : selectedMethod === 'venmo'
                      ? 'Venmo Username'
                      : selectedMethod === 'zelle'
                        ? 'Email/Phone'
                        : selectedMethod === 'cashapp'
                          ? 'Cash App Tag'
                          : 'Agent ID'}
                </label>
                <input
                  type="text"
                  placeholder="Enter destination..."
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

            <button className={styles.confirmBtn} onClick={handleConfirm} disabled={processing}>
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
