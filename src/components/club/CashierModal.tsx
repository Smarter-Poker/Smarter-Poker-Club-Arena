/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER MODAL — Chip Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Allows players to:
 * - View current chip balance
 * - Purchase chips (via onDeposit callback)
 * - Withdraw chips (via onWithdraw callback)
 * - View transaction history
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { masterBus } from '../../core/MasterBus';
import './CashierModal.css';
import { reportError } from '../../utils/errorReporter';

export interface Transaction {
  id: string;
  type: 'deposit' | 'withdrawal' | 'winnings' | 'rake';
  amount: number;
  date: string;
  status: 'completed' | 'pending' | 'failed';
}

export interface CashierModalProps {
  isOpen: boolean;
  onClose: () => void;
  balance: number;
  currency?: string;
  transactions?: Transaction[];
  onDeposit: (amount: number) => Promise<void>;
  onWithdraw: (amount: number) => Promise<void>;
}

export function CashierModal({
  isOpen,
  onClose,
  balance,
  currency = '',
  transactions = [],
  onDeposit,
  onWithdraw,
}: CashierModalProps) {
  type ClubCashierTab = 'deposit' | 'withdraw' | 'history';
  const clubCashierTabs: ClubCashierTab[] = ['deposit', 'withdraw', 'history'];
  const [activeTab, setActiveTab] = useState<'balance' | ClubCashierTab>('balance');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const handleTabChange = useCallback((tab: ClubCashierTab) => {
    setActiveTab(tab);
    setAmount('');
  }, []);

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = clubCashierTabs.indexOf(activeTab as ClubCashierTab);
        if (idx < 0) return;
        const next =
          e.key === 'ArrowRight'
            ? clubCashierTabs[(idx + 1) % clubCashierTabs.length]
            : clubCashierTabs[(idx - 1 + clubCashierTabs.length) % clubCashierTabs.length];
        handleTabChange(next);
        const btn = document.querySelector(
          `[aria-controls="club-cashier-panel-${next}"]`
        ) as HTMLElement;
        btn?.focus();
      }
    },
    [activeTab, handleTabChange]
  );

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

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

  if (!isOpen) return null;

  const handleAction = async () => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;
    if (activeTab === 'withdraw' && val > balance) return;

    setLoading(true);
    try {
      if (activeTab === 'deposit') await onDeposit(val);
      if (activeTab === 'withdraw') await onWithdraw(val);
      setAmount('');
      setActiveTab('balance');
      // Emit bus event so other components (DynamicWallet, CashierPage) refresh balances
      masterBus.emit('BALANCE_UPDATED', { source: activeTab, amount: val });
    } catch (err) {
      reportError(err, 'CashierModal.Cashier_action_failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="cashier-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cashier-modal-title"
    >
      <div
        className="cashier-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        {/* Header */}
        <div className="cashier-modal__header">
          <div className="cashier-modal__title-group">
            <span className="cashier-modal__icon"></span>
            <h2 id="cashier-modal-title" className="cashier-modal__title">
              Cashier
            </h2>
          </div>
          <button className="cashier-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Balance Card */}
        <div className="cashier-balance-card">
          <span className="cashier-balance-label">Current Balance</span>
          <span className="cashier-balance-value">{balance.toLocaleString()}</span>
        </div>

        {/* Tabs */}
        <div
          className="cashier-tabs"
          role="tablist"
          aria-label="Cashier Actions"
          onKeyDown={handleTabKeyDown}
        >
          <button
            role="tab"
            tabIndex={activeTab === 'deposit' ? 0 : -1}
            aria-selected={activeTab === 'deposit'}
            aria-controls="club-cashier-panel-deposit"
            id="club-cashier-tab-deposit"
            className={`cashier-tab ${activeTab === 'deposit' ? 'active' : ''}`}
            onClick={() => handleTabChange('deposit')}
          >
            Deposit
          </button>
          <button
            role="tab"
            tabIndex={activeTab === 'withdraw' ? 0 : -1}
            aria-selected={activeTab === 'withdraw'}
            aria-controls="club-cashier-panel-withdraw"
            id="club-cashier-tab-withdraw"
            className={`cashier-tab ${activeTab === 'withdraw' ? 'active' : ''}`}
            onClick={() => handleTabChange('withdraw')}
          >
            Withdraw
          </button>
          <button
            role="tab"
            tabIndex={activeTab === 'history' ? 0 : -1}
            aria-selected={activeTab === 'history'}
            aria-controls="club-cashier-panel-history"
            id="club-cashier-tab-history"
            className={`cashier-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => handleTabChange('history')}
          >
            History
          </button>
        </div>

        {/* Content */}
        <div
          className="cashier-content"
          id={`club-cashier-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={activeTab !== 'balance' ? `club-cashier-tab-${activeTab}` : undefined}
        >
          {(activeTab === 'deposit' || activeTab === 'withdraw') && (
            <div className="cashier-form">
              <label className="cashier-label">
                {activeTab === 'deposit' ? 'Purchase Amount' : 'Withdrawal Amount'}
              </label>
              <div className="cashier-input-wrapper">
                <span className="cashier-currency"></span>
                <input
                  type="number"
                  className="cashier-input"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min="1"
                />
              </div>

              <div className="cashier-presets">
                {[100, 500, 1000, 5000].map((val) => (
                  <button key={val} type="button" onClick={() => setAmount(val.toString())}>
                    +{val}
                  </button>
                ))}
              </div>

              <button
                className={`cashier-submit-btn ${activeTab}`}
                onClick={handleAction}
                disabled={loading || !amount}
              >
                {loading
                  ? 'Processing...'
                  : activeTab === 'deposit'
                    ? 'Buy Chips'
                    : 'Request Withdrawal'}
              </button>

              <p className="cashier-note">
                {activeTab === 'deposit'
                  ? 'Chips are instantly credited to your account.'
                  : 'Withdrawals are processed by club admins within 24h.'}
              </p>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="cashier-history">
              {transactions.length > 0 ? (
                transactions.map((tx) => (
                  <div key={tx.id} className="tx-row">
                    <div className="tx-info">
                      <span className={`tx-type tx-type--${tx.type}`}>{tx.type}</span>
                      <span className="tx-date">{tx.date}</span>
                    </div>
                    <div className="tx-amount-group">
                      <span
                        className={`tx-amount ${tx.type === 'withdrawal' || tx.type === 'rake' ? 'neg' : 'pos'}`}
                      >
                        {tx.type === 'withdrawal' || tx.type === 'rake' ? '-' : '+'}
                        {tx.amount.toLocaleString()}
                      </span>
                      <span className={`tx-status tx-status--${tx.status}`}>{tx.status}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="tx-empty">No Transaction History Found.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CashierModal;
