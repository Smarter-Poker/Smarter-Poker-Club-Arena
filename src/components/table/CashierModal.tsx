/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER MODAL — Add/Withdraw Chips at Table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium cashier modal for:
 * - Adding chips during play
 * - Withdrawing excess chips
 * - Balance display
 * - Transaction history
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { haptic } from '../../services/SoundService';
import './CashierModal.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CashierTab = 'add' | 'withdraw';

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
  onAddChips: (amount: number) => Promise<void>;
  onWithdrawChips: (amount: number) => Promise<void>;
  currentStack: number;
  accountBalance: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxStack: number; // Max stack allowed at table
  transactions?: CashierTransaction[];
  currency?: string;
  isProcessing?: boolean;
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
  onWithdrawChips,
  currentStack,
  accountBalance,
  minBuyIn,
  maxBuyIn,
  maxStack,
  transactions = [],
  currency = '',
  isProcessing = false,
}: CashierModalProps) {
  const [activeTab, setActiveTab] = useState<CashierTab>('add');
  const [amount, setAmount] = useState(0);
  const [visibleQuick, setVisibleQuick] = useState<boolean[]>([]);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Calculate limits
  const canAddAmount = useMemo(() => {
    const spaceInStack = maxStack - currentStack;
    return Math.min(spaceInStack, accountBalance, maxBuyIn);
  }, [currentStack, maxStack, accountBalance, maxBuyIn]);

  const canWithdrawAmount = useMemo(() => {
    // Can only withdraw down to min buy-in
    return Math.max(0, currentStack - minBuyIn);
  }, [currentStack, minBuyIn]);

  // Quick amount options
  const quickAmounts = useMemo(() => {
    const max = activeTab === 'add' ? canAddAmount : canWithdrawAmount;
    return [
      { label: '25%', value: Math.trunc(max * 0.25 * 100) / 100 },
      { label: '50%', value: Math.trunc(max * 0.5 * 100) / 100 },
      { label: '75%', value: Math.trunc(max * 0.75 * 100) / 100 },
      { label: 'MAX', value: max },
    ];
  }, [activeTab, canAddAmount, canWithdrawAmount]);

  // Reset amount when switching tabs
  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      animTimers.current.forEach(clearTimeout);
    };
  }, []);

  const handleTabChange = useCallback(
    (tab: CashierTab) => {
      setActiveTab(tab);
      setAmount(0);
      setVisibleQuick([]);
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
      const max = tab === 'add' ? canAddAmount : canWithdrawAmount;
      [0, 1, 2, 3].forEach((i) => {
        const t = setTimeout(() => {
          setVisibleQuick((prev) => [...prev, true]);
        }, i * 50);
        animTimers.current.push(t);
      });
    },
    [canAddAmount, canWithdrawAmount]
  );

  // Handle confirm
  const handleConfirm = useCallback(async () => {
    if (amount <= 0 || isProcessing) return;
    haptic.medium();

    try {
      if (activeTab === 'add') {
        await onAddChips(amount);
      } else {
        await onWithdrawChips(amount);
      }
      setAmount(0);
      onClose();
    } catch (error) {
      reportError(error, 'CashierModal.Cashier_error');
    }
  }, [amount, activeTab, isProcessing, onAddChips, onWithdrawChips, onClose]);

  // Validate amount
  const isValidAmount = useMemo(() => {
    if (amount <= 0) return false;
    if (activeTab === 'add') {
      return amount <= canAddAmount;
    }
    return amount <= canWithdrawAmount;
  }, [amount, activeTab, canAddAmount, canWithdrawAmount]);

  // ── Focus Trap: trap focus inside modal when open ──
  const handleFocusTrap = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
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
    },
    [onClose]
  );

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

  // ── Keyboard navigation for tabs (Arrow Left/Right) ──
  const cashierTabs: CashierTab[] = ['add', 'withdraw'];
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = cashierTabs.indexOf(activeTab);
        const next =
          e.key === 'ArrowRight'
            ? cashierTabs[(idx + 1) % cashierTabs.length]
            : cashierTabs[(idx - 1 + cashierTabs.length) % cashierTabs.length];
        handleTabChange(next);
        const btn = document.querySelector(
          `[aria-controls="table-cashier-panel-${next}"]`
        ) as HTMLElement;
        btn?.focus();
      }
    },
    [activeTab, handleTabChange]
  );

  if (!isOpen) return null;

  return (
    <div
      className="cashier-overlay"
      onClick={onClose}
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
          <button className="cashier-modal__close" onClick={onClose}>
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
              {formatAmount(accountBalance, currency)}
            </span>
          </div>
        </div>

        {/* Tabs */}
        <div
          className="cashier-modal__tabs"
          role="tablist"
          aria-label="Cashier actions"
          onKeyDown={handleTabKeyDown}
        >
          <button
            role="tab"
            tabIndex={activeTab === 'add' ? 0 : -1}
            aria-selected={activeTab === 'add'}
            aria-controls="table-cashier-panel-add"
            id="table-cashier-tab-add"
            className={`cashier-modal__tab ${activeTab === 'add' ? 'cashier-modal__tab--active' : ''}`}
            onClick={() => handleTabChange('add')}
          >
            Add Chips
          </button>
          <button
            role="tab"
            tabIndex={activeTab === 'withdraw' ? 0 : -1}
            aria-selected={activeTab === 'withdraw'}
            aria-controls="table-cashier-panel-withdraw"
            id="table-cashier-tab-withdraw"
            className={`cashier-modal__tab ${activeTab === 'withdraw' ? 'cashier-modal__tab--active' : ''}`}
            onClick={() => handleTabChange('withdraw')}
          >
            Withdraw
          </button>
        </div>

        {/* Amount Input */}
        <div
          className="cashier-modal__input-section"
          id={`table-cashier-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`table-cashier-tab-${activeTab}`}
        >
          <div className="cashier-modal__input-wrapper">
            <span className="cashier-modal__currency">{currency}</span>
            <input
              type="number"
              className="cashier-modal__input"
              value={amount || ''}
              onChange={(e) => setAmount(Math.max(0, parseInt(e.target.value) || 0))}
              placeholder="0"
              min={0}
              max={activeTab === 'add' ? canAddAmount : canWithdrawAmount}
            />
          </div>
          <div className="cashier-modal__limit">
            {activeTab === 'add' ? (
              <span>Available to add: {formatAmount(canAddAmount, currency)}</span>
            ) : (
              <span>Available to withdraw: {formatAmount(canWithdrawAmount, currency)}</span>
            )}
          </div>
        </div>

        {/* Quick Amounts */}
        <div className="cashier-modal__quick-amounts">
          {quickAmounts.map(({ label, value }, idx) => (
            <button
              key={label}
              className={`cashier-modal__quick-btn ${amount === value ? 'cashier-modal__quick-btn--active' : ''}`}
              onClick={() => setAmount(value)}
              disabled={value <= 0}
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
          <span
            className={`cashier-modal__preview-value ${activeTab === 'add' ? 'cashier-modal__preview-value--add' : 'cashier-modal__preview-value--withdraw'}`}
          >
            {formatAmount(
              activeTab === 'add' ? currentStack + amount : currentStack - amount,
              currency
            )}
          </span>
        </div>

        {/* Confirm Button */}
        <div className="cashier-modal__actions">
          <button
            className={`cashier-modal__confirm-btn ${!isValidAmount || isProcessing ? 'cashier-modal__confirm-btn--disabled' : ''}`}
            onClick={handleConfirm}
            disabled={!isValidAmount || isProcessing}
          >
            {isProcessing ? (
              <>
                <span className="cashier-modal__spinner" />
                Processing...
              </>
            ) : activeTab === 'add' ? (
              `Add ${formatAmount(amount, currency)}`
            ) : (
              `Withdraw ${formatAmount(amount, currency)}`
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
